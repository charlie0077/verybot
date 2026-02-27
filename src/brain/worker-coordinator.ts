import type { MessageQueue } from "./queue.js";
import type { SessionStateMap } from "./session-state.js";
import { logger } from "../logger.js";

/** Debounce delay before re-triggering orchestrator after worker completion. */
const WORKER_TRIGGER_DEBOUNCE_MS = 2_000;
/** Max times the orchestrator can be auto-triggered by worker results per user message. */
const MAX_DELEGATION_DEPTH = 5;
/** Prefix for synthetic messages injected when workers complete. */
const WORKER_RESULTS_PREFIX = "[worker_results]";

/**
 * Coordinates worker completion and orchestrator re-triggering.
 * Debounces multiple concurrent worker completions into a single LLM call.
 */
export class WorkerCoordinator {
  private sessions: SessionStateMap;
  private queue: MessageQueue;

  constructor(sessions: SessionStateMap, queue: MessageQueue) {
    this.sessions = sessions;
    this.queue = queue;
  }

  /**
   * Called when a worker finishes. Debounces multiple completions into a single
   * orchestrator re-trigger so concurrent workers batch into one LLM call.
   */
  onWorkerComplete(sessionKey: string, channelId: string): void {
    const state = this.sessions.get(sessionKey);
    if (!state) return;

    // Accumulate completed channel IDs during debounce window
    if (!state.workerPendingChannels) {
      state.workerPendingChannels = new Set();
    }
    state.workerPendingChannels.add(channelId);

    // Debounce: reset timer on each completion
    if (state.workerTriggerTimer) clearTimeout(state.workerTriggerTimer);

    state.workerTriggerTimer = setTimeout(() => {
      state.workerTriggerTimer = undefined;
      this.triggerOrchestratorForWorkerResults(sessionKey);
    }, WORKER_TRIGGER_DEBOUNCE_MS);
  }

  /**
   * Track delegation depth: synthetic worker triggers increment, real messages reset.
   * Returns true if the message is a worker result synthetic message.
   */
  trackDelegationDepth(sessionKey: string, text: string): void {
    const state = this.sessions.get(sessionKey);
    if (!state) return;

    if (text.startsWith(WORKER_RESULTS_PREFIX)) {
      state.delegationDepth++;
    } else {
      state.delegationDepth = 0;
    }
  }

  /** Cancel all pending debounce timers (e.g. on shutdown). */
  clearAllTimers(): void {
    this.sessions.clearAllTimers();
  }

  /** Enqueue a synthetic message to re-trigger the orchestrator after workers finish. */
  private triggerOrchestratorForWorkerResults(sessionKey: string): void {
    const state = this.sessions.get(sessionKey);
    if (!state) return;

    if (state.delegationDepth >= MAX_DELEGATION_DEPTH) {
      logger.warn(`[${sessionKey}] Delegation depth limit reached (${MAX_DELEGATION_DEPTH}), skipping re-trigger`);
      return;
    }

    const channelIds = state.workerPendingChannels ? [...state.workerPendingChannels] : [];
    state.workerPendingChannels = undefined;

    const channelList = channelIds.map((id) => `- ${id}`).join("\n");
    const synthetic = `${WORKER_RESULTS_PREFIX}\nWorker agents have completed. Call read_channel for each:\n${channelList}`;
    const deliver = state.replyCallback;
    this.queue.enqueue(sessionKey, synthetic).then(
      (reply) => {
        if (reply && deliver) {
          deliver(reply).catch((err) => {
            logger.error(`[${sessionKey}] Failed to deliver worker trigger reply: ${err instanceof Error ? err.message : err}`);
          });
        }
      },
      (err) => {
        logger.error(`[${sessionKey}] Failed to enqueue worker trigger: ${err instanceof Error ? err.message : err}`);
      },
    );
  }
}
