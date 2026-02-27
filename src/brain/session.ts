import type { LanguageModel, ModelMessage } from "ai";
import { compactMessages } from "./compaction.js";

export interface PendingCompaction {
  summary: string;
}

export class Session {
  readonly key: string;
  private messages: ModelMessage[] = [];
  private persistedCount = 0; // how many messages are already on disk
  private _pendingCompaction: PendingCompaction | null = null;
  private _needsFullRewrite = false;

  constructor(key: string, messages: ModelMessage[] = []) {
    this.key = key;
    this.messages = messages;
    this.persistedCount = messages.length;
  }

  append(msg: ModelMessage) {
    this.messages.push(msg);
  }

  getMessages(): ModelMessage[] {
    return [...this.messages];
  }

  /** Returns only messages not yet written to disk (normal append path). */
  getNewMessages(): ModelMessage[] {
    return this.messages.slice(this.persistedCount);
  }

  /** After compaction: returns kept + new messages (everything except the summary at index 0). */
  getCompactionMessages(): ModelMessage[] {
    return this.messages.slice(1);
  }

  /** Mark all current messages as persisted. */
  markPersisted() {
    this.persistedCount = this.messages.length;
    this._pendingCompaction = null;
    this._needsFullRewrite = false;
  }

  /** Pending compaction info for the store to persist as a marker. */
  get pendingCompaction(): PendingCompaction | null {
    return this._pendingCompaction;
  }

  /** True when the file must be fully overwritten (emergency truncate). */
  get needsFullRewrite(): boolean {
    return this._needsFullRewrite;
  }

  /** LLM-based compaction — summarizes old messages when tokens exceed context budget. */
  async compact(model: LanguageModel, contextWindow: number, systemPrompt: string): Promise<boolean> {
    const result = await compactMessages(model, this.messages, contextWindow, systemPrompt);
    if (result.compacted) {
      this.messages = result.messages;
      if (result.summary) {
        // LLM summarization succeeded — persist as append-only compaction marker
        this._pendingCompaction = { summary: result.summary };
      } else {
        // Fallback truncation (no summary) — needs full file rewrite
        this._needsFullRewrite = true;
      }
    }
    return result.compacted;
  }

  /** Replace the internal messages array (e.g. after programmatic compaction). Marks full rewrite. */
  replaceMessages(messages: ModelMessage[]): void {
    this.messages = messages;
    this._needsFullRewrite = true;
  }

  /** Emergency truncation — drop oldest messages, keeping last N. */
  truncate(keep: number): void {
    if (this.messages.length > keep) {
      this.messages = this.messages.slice(-keep);
      this._needsFullRewrite = true;
    }
  }

  get messageCount(): number {
    return this.messages.length;
  }

  get updatedAt(): number {
    return Date.now();
  }
}
