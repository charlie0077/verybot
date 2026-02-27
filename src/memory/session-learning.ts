import type { LanguageModel, ModelMessage } from "ai";
import type { MemoryStore } from "./store.js";
import type { EmbeddingProvider } from "./embedding.js";
import { extractFacts } from "./extractor.js";
import { saveExplicitMemory } from "./explicit.js";

const MAX_LEARN_SOURCE_MESSAGES = 40;

export interface LearnSessionMemoriesInput {
  model: LanguageModel;
  memoryStore: MemoryStore;
  embeddingProvider: EmbeddingProvider | null;
  sessionKey: string;
  messages: ModelMessage[];
  teamId?: string;
  topic?: string;
}

export interface LearnSessionMemoriesResult {
  topic?: string;
  extracted: number;
  saved: number;
  skipped: number;
  savedFacts: string[];
}

/**
 * Extract and save learnable facts from session messages.
 */
export async function learnSessionMemories(
  input: LearnSessionMemoriesInput,
): Promise<LearnSessionMemoriesResult> {
  const topic = normalizeTopic(input.topic);
  const extractedFacts = await extractFacts(input.model, input.messages, {
    topic,
    maxMessages: MAX_LEARN_SOURCE_MESSAGES,
  });

  if (extractedFacts.length === 0) {
    return {
      topic,
      extracted: 0,
      saved: 0,
      skipped: 0,
      savedFacts: [],
    };
  }

  const savedFacts: string[] = [];
  let skipped = 0;
  for (const fact of extractedFacts) {
    try {
      const result = await saveExplicitMemory(input.memoryStore, input.embeddingProvider, {
        fact,
        source: input.sessionKey,
        teamId: input.teamId,
      });
      if (result.saved) {
        savedFacts.push(result.fact);
      } else {
        skipped++;
      }
    } catch {
      skipped++;
    }
  }

  return {
    topic,
    extracted: extractedFacts.length,
    saved: savedFacts.length,
    skipped,
    savedFacts,
  };
}

function normalizeTopic(topic: string | undefined): string | undefined {
  if (typeof topic !== "string") return undefined;
  const trimmed = topic.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
