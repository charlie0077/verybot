import type { ToolSet } from "ai";
import type { Config } from "../config.js";
import type { TaskStore } from "../tasks/store.js";
import type { TeamStore } from "../teams/store.js";
import type { MemoryStore } from "../memory/store.js";
import type { EmbeddingProvider } from "../memory/embedding.js";
import type { SkillManager } from "../skills/loader.js";
import type { BrowserConfig } from "../computer/browser/manager.js";
import type { Task, TaskStatusConfig } from "../tasks/types.js";
import { DEFAULT_TASK_STATUSES } from "../tasks/types.js";
import { Session } from "./session.js";
import { SessionStore } from "./session-store.js";
import { buildSystemPrompt } from "./context.js";
import { runLoop } from "./loop.js";
import { adaptTools } from "./mcp-adapter.js";
import { getModel } from "./providers.js";
import { resolveModelDef } from "../config/model-catalog.js";
import { parseModel } from "./agent-registry.js";
import { createMemorySearchTool } from "../tools/memory.js";
import { createTaskTools } from "../tools/tasks.js";
import { resolveInlineAttachmentContent } from "../tasks/inline-attachment-content.js";
import { BrowserManager } from "../computer/browser/manager.js";
import { createBrowserTools, BROWSER_TOOL_NAMES } from "../computer/browser/tools.js";
import { emit } from "../events.js";
import { logger } from "../logger.js";
import { buildUserMessageContent } from "./user-content.js";

/** Poll interval for checking subscribed tasks. */
const POLL_INTERVAL_MS = 5_000;
/** Default max steps for subscription workers. */
const DEFAULT_WORKER_MAX_STEPS = 20;
/** Claims older than this are considered stale and released (30 minutes). */
const STALE_CLAIM_TIMEOUT_MS = 30 * 60 * 1_000;
/** Max candidates to consider per poll tick. */
const CLAIMABLE_CANDIDATE_LIMIT = 20;
/** Safety cap: max claims per single poll tick to prevent runaway. */
const MAX_CLAIMS_PER_TICK = 50;

export interface SubscriberDeps {
  taskStore: TaskStore;
  teamStore: TeamStore;
  sessionStore: SessionStore;
  memoryStore: MemoryStore | null;
  embeddingProvider: EmbeddingProvider | null;
  memoryMaxResults: number;
  config: Config;
  baseTools: ToolSet;
  skillManager: SkillManager;
  browserConfig: BrowserConfig | null;
  sandboxEnabled: boolean;
}

interface ClaimResult {
  agentId: string;
  teamId: string;
  agentName: string;
  model: string;
  task: Task;
}

/**
 * Pull-based task execution: workers subscribe to task statuses
 * and self-select tasks from the board. Runs a single poll timer
 * and an efficient cross-table query per tick.
 */
export class TaskSubscriberManager {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** agentId → Set<taskId> of currently running tasks */
  private activeRuns = new Map<string, Set<string>>();
  private polling = false;

  constructor(private deps: SubscriberDeps) {}

  start(): void {
    if (this.timer) return;
    this.poll();
    this.timer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private poll(): void {
    if (this.polling) return;
    this.polling = true;
    try {
      // Release stale claims from crashed workers
      this.cleanupStaleClaims();

      // Claim as many tasks as possible in one tick (capped to prevent runaway)
      for (let i = 0; i < MAX_CLAIMS_PER_TICK; i++) {
        const result = this.findAndClaim();
        if (!result) break;
        // Fire-and-forget — runWorker is async, poll returns immediately
        this.runWorker(result).catch((err) => {
          logger.error(`[task-subscriber] runWorker unhandled error: ${err instanceof Error ? err.message : err}`);
        });
      }
    } finally {
      this.polling = false;
    }
  }

  /** Release claims that have been held longer than STALE_CLAIM_TIMEOUT_MS. */
  private cleanupStaleClaims(): void {
    const cutoff = Date.now() - STALE_CLAIM_TIMEOUT_MS;
    const released = this.deps.taskStore.cleanupStaleClaims(cutoff);
    if (released > 0) {
      logger.warn(`[task-subscriber] Released ${released} stale claim(s)`);
    }
  }

  /** Emit `taskChange.updated` with the latest task snapshot if it still exists. */
  private emitTaskUpdated(taskId: string): void {
    const latest = this.deps.taskStore.getById(taskId);
    if (!latest) return;
    emit("taskChange", { action: "updated", task: latest });
  }

  /**
   * Find a claimable task and atomically claim it via the store.
   * Uses TeamStore.findClaimableTasks() for cross-table query,
   * then TaskStore.claimTask() for atomic claim.
   */
  private findAndClaim(): ClaimResult | null {
    // Compute busy agents in-memory (not DB-level)
    const fullAgentIds = new Set<string>();
    for (const [agentId, tasks] of this.activeRuns) {
      const agent = this.deps.teamStore.getAgentById(agentId);
      const limit = agent?.concurrency ?? 1;
      if (tasks.size >= limit) fullAgentIds.add(agentId);
    }

    // Query candidates via store method (small result set)
    const candidates = this.deps.teamStore.findClaimableTasks(CLAIMABLE_CANDIDATE_LIMIT);

    // Find first candidate whose agent isn't at capacity
    const match = candidates.find((c) => !fullAgentIds.has(c.agentId));
    if (!match) return null;

    // Claim atomically via store
    const task = this.deps.taskStore.claimTaskById(match.taskId, match.agentId);
    if (!task) return null;

    return {
      agentId: match.agentId,
      teamId: match.teamId,
      agentName: match.agentName,
      model: match.model,
      task,
    };
  }

  /**
   * Run full LLM loop for a claimed task.
   * Follows same pattern as delegate.ts runWorker().
   */
  private async runWorker(claim: ClaimResult): Promise<void> {
    const { agentId, teamId, agentName, model: agentModel, task } = claim;
    let teamName: string | undefined = this.deps.teamStore.getTeamById(task.teamId)?.name;
    const sessionKey = `${teamId}:task:${task.id}:${agentName}:${Date.now()}`;
    const session = new Session(sessionKey);
    let activeRunsForAgent = this.activeRuns.get(agentId);
    if (!activeRunsForAgent) {
      activeRunsForAgent = new Set();
      this.activeRuns.set(agentId, activeRunsForAgent);
    }
    activeRunsForAgent.add(task.id);

    try {
      const userMessage = task.description
        ? `${task.title}\n\n${task.description}`
        : task.title;
      const { normalizedText, imageDataUrls } = await resolveInlineAttachmentContent(userMessage);
      session.append({ role: "user", content: buildUserMessageContent(normalizedText, imageDataUrls) });

      // 1. Resolve agent config
      const agentRow = this.deps.teamStore.getRuntimeAgentById(agentId);
      if (!agentRow) throw new Error(`Agent not found: ${agentId}`);

      // 2. Resolve model
      const { provider, modelId, codexReasoningEffort } = parseModel(agentModel);
      const model = getModel(provider, modelId, { codexReasoningEffort });

      // 3. Build worker tools (filtered base tools + memory_search + task tools)
      const baseTools = this.filterTools(agentRow.tools);
      const workerTools: ToolSet = { ...baseTools };

      // Browser: give worker its own instance
      const hasBrowserTools = BROWSER_TOOL_NAMES.some((n) => n in workerTools);
      let workerBrowser: BrowserManager | null = null;
      if (hasBrowserTools && this.deps.browserConfig) {
        for (const n of BROWSER_TOOL_NAMES) delete workerTools[n];
        workerBrowser = new BrowserManager({ ...this.deps.browserConfig, profileDir: "temp" });
        Object.assign(workerTools, createBrowserTools(workerBrowser));
      }

      // Memory search (read-only)
      if (this.deps.memoryStore) {
        workerTools.memory_search = createMemorySearchTool(
          this.deps.memoryStore,
          this.deps.embeddingProvider,
          this.deps.memoryMaxResults,
        );
      }

      // Task tools scoped to the task's team, with team's custom statuses
      const team = this.deps.teamStore.getTeamById(task.teamId);
      if (team?.name) teamName = team.name;
      const configuredStatuses: TaskStatusConfig[] =
        team?.statuses && team.statuses.length > 0 ? team.statuses : DEFAULT_TASK_STATUSES;
      const taskTools = createTaskTools(this.deps.taskStore, task.teamId, configuredStatuses, {
        clearClaimOnStatusChange: false,
        requireClaimedByForStatusChange: agentId,
        updatedBy: agentId,
      });
      Object.assign(workerTools, this.filterToolSetByAllowlist(taskTools, agentRow.tools));

      // 4. System prompt (task-specific mode for subscribed workers)
      const system = buildSystemPrompt({
        identity: agentRow.identity,
        modelId,
        teamWorkspace: team?.workspace,
        hasMemory: this.deps.memoryStore !== null,
        subscribedTask: {
          id: task.id,
          teamId: task.teamId,
          title: task.title,
          currentStatus: task.status,
          availableStatusKeys: configuredStatuses.map((status) => status.key),
        },
      });

      logger.info(`[task-subscriber] ${agentRow.name} claimed task ${task.id}: ${task.title.slice(0, 100)}`);

      try {
        await this.deps.sessionStore.save(session);
        this.deps.sessionStore.updateMetadata(sessionKey, {
          teamId: task.teamId,
          ...(teamName ? { teamName } : {}),
          channelType: "worker",
          agentId,
          agentName: agentRow.name,
        });
      } catch (err) {
        logger.warn(`[task-subscriber] ${agentRow.name} failed to create session ${sessionKey}: ${err instanceof Error ? err.message : err}`);
      }
      this.emitTaskUpdated(task.id);

      emit("agent", {
        sessionKey,
        tools: [],
        subscription: { agentId, agentName, taskId: task.id, status: "started" },
      });

      // 6. Adapt tools and run loop
      const maxSteps = agentRow.maxSteps > 0 ? agentRow.maxSteps : DEFAULT_WORKER_MAX_STEPS;
      const workerLabel = `worker:${team?.name ?? task.teamId}:${agentRow.name}:task:${task.id}`;
      let cleanup: (() => Promise<void>) | undefined;
      try {
        const adapted = await adaptTools(provider, modelId, model, workerTools, {
          sandboxEnabled: this.deps.sandboxEnabled,
          cwd: team?.workspace?.trim() || undefined,
        });
        cleanup = adapted.cleanup;

        const { text, responseMessages } = await runLoop({
          model: adapted.model,
          system,
          messages: session.getMessages(),
          tools: adapted.tools,
          sessionKey,
          sessionLabel: workerLabel,
          agentId,
          maxSteps,
          silent: false,
        });

        // Append response messages and save session
        for (const msg of responseMessages) session.append(msg);
        await this.deps.sessionStore.save(session);
        this.deps.sessionStore.updateMetadata(sessionKey, {
          teamId: task.teamId,
          ...(teamName ? { teamName } : {}),
          channelType: "worker",
          agentId,
          agentName: agentRow.name,
        });

        // NOTE: Workers set final status only when task_update is available to that worker.
        // We no longer hardcode status: "done" here because teams may use custom statuses.
        emit("agent", {
          sessionKey,
          tools: [],
          subscription: { agentId, agentName, taskId: task.id, status: "completed", resultLength: text.length },
        });

        logger.info(`[task-subscriber] ${agentRow.name} completed task ${task.id} (${text.length} chars)`);
      } finally {
        if (cleanup) {
          try { await cleanup(); } catch (err) {
            logger.warn(`[task-subscriber] ${agentRow.name} MCP cleanup failed: ${err instanceof Error ? err.message : err}`);
          }
        }
        if (workerBrowser?.isLaunched()) {
          workerBrowser.close().catch((err) => {
            logger.warn(`[task-subscriber] ${agentRow.name} browser cleanup failed: ${err instanceof Error ? err.message : err}`);
          });
        }
      }
    } catch (err) {
      logger.error(`[task-subscriber] ${agentName} failed on task ${task.id}: ${err instanceof Error ? err.message : err}`);
      const error = err instanceof Error ? err.message : String(err);
      session.append({ role: "assistant", content: `Task execution failed: ${error}` });
      try {
        await this.deps.sessionStore.save(session);
        this.deps.sessionStore.updateMetadata(sessionKey, {
          teamId: task.teamId,
          ...(teamName ? { teamName } : {}),
          channelType: "worker",
          agentId,
          agentName,
        });
      } catch (saveErr) {
        logger.warn(`[task-subscriber] ${agentName} failed to persist error session ${sessionKey}: ${saveErr instanceof Error ? saveErr.message : saveErr}`);
      }

      emit("agent", {
        sessionKey,
        tools: [],
        subscription: { agentId, agentName, taskId: task.id, status: "failed", error },
      });
    } finally {
      // Finalize only if this worker still owns the claim:
      // mark processed for current task version and release claim atomically.
      const finalized = this.deps.taskStore.finalizeClaimedTaskRun(task.id, agentId);
      if (finalized) this.emitTaskUpdated(task.id);

      activeRunsForAgent?.delete(task.id);
      if (activeRunsForAgent?.size === 0) this.activeRuns.delete(agentId);

      // Check for more work after a worker finishes (non-blocking)
      queueMicrotask(() => this.poll());
    }
  }

  /** Filter base tools by agent allowlist (empty = inherit all). */
  private filterTools(allowlist: string[]): ToolSet {
    return this.filterToolSetByAllowlist(this.deps.baseTools, allowlist);
  }

  private filterToolSetByAllowlist(toolSet: ToolSet, allowlist: string[]): ToolSet {
    if (allowlist.length === 0) return { ...toolSet };
    const filtered: ToolSet = {};
    for (const name of allowlist) {
      if (name in toolSet) filtered[name] = toolSet[name];
    }
    return filtered;
  }
}
