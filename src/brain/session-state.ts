import type { Session } from "./session.js";

/** Consolidated per-session state (replaces 8 separate Maps). */
export interface SessionState {
  session: Session;
  agentId?: string;
  teamId?: string;
  channelType?: string;
  channelId?: string;
  integrations?: Set<string>;
  messagesSinceExtraction: number;
  delegationDepth: number;
  /** Running estimate of message tokens (chars / 4). Updated on append, reset on compaction. */
  estimatedMsgTokens: number;
  replyCallback?: (reply: string) => Promise<void>;
  workerTriggerTimer?: ReturnType<typeof setTimeout>;
  workerPendingChannels?: Set<string>;
  /** Integrations for the next scheduled task run (consumed once by main()). */
  scheduledIntegrations?: string[];
}

/**
 * Type-safe wrapper around a Map<string, SessionState>.
 * Provides convenient accessors and cleanup helpers.
 */
export class SessionStateMap {
  private map = new Map<string, SessionState>();

  get(key: string): SessionState | undefined {
    return this.map.get(key);
  }

  /** Get existing state or create a new entry with the given session. */
  getOrCreate(key: string, session: Session): SessionState {
    let state = this.map.get(key);
    if (!state) {
      state = {
        session,
        messagesSinceExtraction: 0,
        delegationDepth: 0,
        estimatedMsgTokens: 0,
      };
      this.map.set(key, state);
    }
    return state;
  }

  /** Set a session state (used when loading from store). */
  set(key: string, state: SessionState): void {
    this.map.set(key, state);
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  delete(key: string): void {
    const state = this.map.get(key);
    if (state?.workerTriggerTimer) {
      clearTimeout(state.workerTriggerTimer);
    }
    this.map.delete(key);
  }

  entries(): IterableIterator<[string, SessionState]> {
    return this.map.entries();
  }

  /** Cancel all pending debounce timers (e.g. on shutdown). */
  clearAllTimers(): void {
    for (const state of this.map.values()) {
      if (state.workerTriggerTimer) {
        clearTimeout(state.workerTriggerTimer);
        state.workerTriggerTimer = undefined;
      }
      state.workerPendingChannels = undefined;
    }
  }
}
