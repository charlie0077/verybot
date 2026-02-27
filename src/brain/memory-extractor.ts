import { randomUUID } from "crypto";
import type { LanguageModel, ModelMessage } from "ai";
import type { MemoryStore } from "../memory/store.js";
import type { EmbeddingProvider } from "../memory/embedding.js";
import { extractFacts } from "../memory/extractor.js";
import { deriveMemoryTeamId } from "./session-key.js";
import { logger } from "../logger.js";
import type { SessionStateMap } from "./session-state.js";

/** Run fact extraction every N user messages (not every message). */
const EXTRACT_EVERY_N = 5;

/**
 * Handles memory extraction from conversation sessions.
 * Tracks per-session message counts and batches extraction.
 */
export class MemoryExtractor {
  private model: LanguageModel;
  private memoryStore: MemoryStore;
  private embeddingProvider: EmbeddingProvider | null;

  constructor(
    model: LanguageModel,
    memoryStore: MemoryStore,
    embeddingProvider: EmbeddingProvider | null,
  ) {
    this.model = model;
    this.memoryStore = memoryStore;
    this.embeddingProvider = embeddingProvider;
  }

  /** Update the model used for extraction (e.g. after config reload). */
  setModel(model: LanguageModel): void {
    this.model = model;
  }

  /**
   * Increment extraction counter and trigger extraction if threshold reached.
   * Non-blocking: extraction runs in background.
   */
  trackAndMaybeExtract(
    sessionKey: string,
    sessions: SessionStateMap,
    messages: ModelMessage[],
    teamId?: string,
  ): void {
    const state = sessions.get(sessionKey);
    if (!state) return;

    const count = state.messagesSinceExtraction + 1;
    state.messagesSinceExtraction = count;

    if (count >= EXTRACT_EVERY_N) {
      state.messagesSinceExtraction = 0;
      const recent = messages.slice(-EXTRACT_EVERY_N * 2);
      this.extractAndSaveFacts(sessionKey, recent, teamId).catch((err) => {
        logger.warn(`Fact extraction failed: ${err instanceof Error ? err.message : err}`);
      });
    }
  }

  /** Extract and save facts from messages to memory store. */
  async extractAndSaveFacts(
    sessionKey: string,
    messages: Parameters<typeof extractFacts>[1],
    teamId?: string,
  ): Promise<void> {
    const facts = await extractFacts(this.model, messages);
    if (facts.length === 0) return;

    // Embed all facts in parallel when a provider is available
    const embeddings = this.embeddingProvider
      ? await Promise.all(facts.map((f) => this.embeddingProvider!.embed(f)))
      : facts.map(() => undefined);

    let saved = 0;
    for (let i = 0; i < facts.length; i++) {
      const wasSaved = this.memoryStore.save({
        id: randomUUID(),
        fact: facts[i],
        source: sessionKey,
        timestamp: Date.now(),
        embedding: embeddings[i],
        teamId,
      });
      if (wasSaved) saved++;
    }

    if (saved > 0) {
      logger.info(`[${sessionKey}] Saved ${saved} new memories (${facts.length - saved} duplicates skipped)`);
    }
  }

  /** Extract remaining facts from all active sessions (call before shutdown). */
  async flushAll(sessions: SessionStateMap): Promise<void> {
    for (const [sessionKey, state] of sessions.entries()) {
      if (state.messagesSinceExtraction > 0) {
        try {
          const flushTeamId = deriveMemoryTeamId(sessionKey);
          await this.extractAndSaveFacts(sessionKey, state.session.getMessages(), flushTeamId);
        } catch (err) {
          logger.warn(`Shutdown extraction failed for ${sessionKey}: ${err instanceof Error ? err.message : err}`);
        }
      }
    }
  }
}
