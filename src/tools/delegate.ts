import { randomUUID } from "crypto";
import { tool, type ModelMessage, type ToolSet } from "ai";
import { z } from "zod";
import type { AgentRegistry } from "../brain/agent-registry.js";
import type { ChannelStore } from "../brain/channel-store.js";
import type { DelegationStore } from "../brain/delegation-store.js";
import type { SessionStore } from "../brain/session-store.js";
import type { MemoryStore } from "../memory/store.js";
import type { EmbeddingProvider } from "../memory/embedding.js";
import { Session } from "../brain/session.js";
import { buildSystemPrompt } from "../brain/context.js";
import { runLoop } from "../brain/loop.js";
import { adaptTools } from "../brain/mcp-adapter.js";
import { buildUserMessageContent } from "../brain/user-content.js";
import { createMemorySearchTool } from "./memory.js";
import { emit } from "../events.js";
import { logger } from "../logger.js";
import { resolveInlineAttachmentContent } from "../tasks/inline-attachment-content.js";

import { BrowserManager, type BrowserConfig } from "../computer/browser/manager.js";
import { createBrowserTools, BROWSER_TOOL_NAMES } from "../computer/browser/tools.js";
import { DEFAULT_WORKER_TIMEOUT_S } from "../config/agent-config.js";
import { parseModelSpec, type CodexReasoningEffort } from "../config/model-spec.js";

/**
 * Creates delegation tools:
 * - `delegate`      — fires a worker in background, returns channel ID immediately
 * - `list_workers`  — lists worker names
 * - `worker_get`    — gets full config for one worker
 * - `read_channel`  — reads all messages from a channel (available to orchestrator AND workers)
 */
export function createDelegationTools(
  registry: AgentRegistry,
  channelStore: ChannelStore,
  delegationStore: DelegationStore,
  sessionStore: SessionStore,
  orchestratorId: string,
  sessionKey: string,
  memoryStore: MemoryStore | null,
  embeddingProvider: EmbeddingProvider | null,
  memoryMaxResults: number,
  onWorkerComplete: (sessionKey: string, channelId: string) => void,
  browserConfig: BrowserConfig | null,
  /** Human-readable session label for logs (team name instead of UUID). */
  sessionLabel?: string,
  /** Whether docker sandboxing is enabled (forwarded to MCP adapter). */
  sandboxEnabled = false,
): ToolSet {
  const delegatable = registry.delegatableWorkers();
  const idToName = registry.buildIdToNameMap();
  const listWorkersToolName = "list_workers" as const;
  const workerGetToolName = "worker_get" as const;

  const delegate = tool({
    description:
      `Delegate a task to a specialized worker agent. Returns immediately with a channel ID — the worker runs in the background. ` +
      `You will be automatically notified when workers finish. Use read_channel to see results. ` +
      `Use ${listWorkersToolName} to discover available worker names. ` +
      `You can fire multiple delegations in the same step — they all run concurrently. ` +
      `Pass contextChannels to give the worker read access to other workers' channels.`,
    inputSchema: z.object({
      worker: z
        .string()
        .describe("Which worker name to delegate to"),
      task: z
        .string()
        .describe("Self-contained task description for the worker"),
      contextChannels: z
        .array(z.string())
        .optional()
        .describe("Channel IDs the worker can read for context from other workers"),
    }),
    execute: async ({ worker, task, contextChannels }) => {
      const resolved = registry.resolveWorker(worker);
      if (!resolved) {
        return `Unknown worker: ${worker}. Call ${listWorkersToolName} to see available workers.`;
      }

      const { agentConfig, model, tools: workerBaseTools } = resolved;
      const agentId = agentConfig.id;
      const agentName = agentConfig.name;

      // Create channel for this delegation
      const channelId = channelStore.createChannel();
      channelStore.post(channelId, orchestratorId, "task", task);

      // Record in delegation store (uses DB id for storage)
      const delegationId = randomUUID().slice(0, 8);
      delegationStore.insert({
        id: delegationId,
        agentId,
        sessionKey,
        task,
        channelId,
        status: "running",
        createdAt: Date.now(),
      });

      // Worker tools: base (filtered) + memory_search (read-only) + read_channel
      // Give worker its own browser instance (temp profile) so it doesn't conflict with others
      const hasBrowserTools = BROWSER_TOOL_NAMES.some((n) => n in workerBaseTools);
      let workerBrowser: BrowserManager | null = null;
      const workerTools: ToolSet = { ...workerBaseTools };
      if (hasBrowserTools && browserConfig) {
        // Strip shared browser tools, replace with per-worker instance
        for (const n of BROWSER_TOOL_NAMES) delete workerTools[n];
        workerBrowser = new BrowserManager({ ...browserConfig, profileDir: "temp" });
        Object.assign(workerTools, createBrowserTools(workerBrowser));
      }
      if (memoryStore) {
        workerTools.memory_search = createMemorySearchTool(
          memoryStore,
          embeddingProvider,
          memoryMaxResults,
        );
      }
      // Workers can read channels (their own + any context channels)
      workerTools.read_channel = createReadChannelTool(channelStore, idToName);

      // Build context hint about available channels
      let channelHint = "";
      if (contextChannels?.length) {
        channelHint = `\n\nYou have access to read_channel. Context channels from other workers: ${contextChannels.join(", ")}. Call read_channel to see their results before starting your work.`;
      }

      const system = buildSystemPrompt({
        identity: agentConfig.identity,
        hasMemory: memoryStore !== null,
      });

      // Worker key extends parent key: {parentSessionKey}:{workerName}:{timestamp}
      const workerSessionKey = `${sessionKey}:${agentName}:${Date.now()}`;
      const session = new Session(workerSessionKey);
      const workerTaskInput = task + channelHint;
      const { normalizedText, imageDataUrls } = await resolveInlineAttachmentContent(workerTaskInput);
      session.append({
        role: "user",
        content: buildUserMessageContent(normalizedText, imageDataUrls),
      });

      logger.info(`[delegate] ${orchestratorId} -> ${agentName}: ${task.slice(0, 200)} (channel: ${channelId})`);

      emit("agent", {
        sessionKey,
        delegation: { agentId, agentName, channelId, status: "started" },
      });

      // Fire worker in background with timeout — does NOT await
      const workerMaxSteps = agentConfig.maxSteps > 0 ? agentConfig.maxSteps : undefined;
      const workerLabel = sessionLabel ? `worker:${sessionLabel}:${agentName}` : undefined;
      const parsedWorkerModel = parseModelSpec(agentConfig.model);
      const workerProvider = parsedWorkerModel.provider;
      const workerModelId = parsedWorkerModel.modelId;
      const workerCodexReasoningEffort = parsedWorkerModel.codexReasoningEffort;
      // Extract team name from sessionLabel (format: "TeamName:channel:id...") for worker metadata
      const teamName = sessionLabel?.split(":")[0];
      const timeoutMs = (agentConfig.timeout ?? DEFAULT_WORKER_TIMEOUT_S) * 1_000;
      withTimeout(
        runWorker(
          agentId,
          agentName,
          model,
          workerProvider,
          workerModelId,
          workerCodexReasoningEffort,
          system,
          session,
          workerTools,
          workerSessionKey,
          workerMaxSteps,
          workerLabel,
          sandboxEnabled,
        ),
        timeoutMs,
        `Worker ${agentName} timed out after ${timeoutMs / 1_000}s`,
      ).then(
        ({ text: result, responseMessages }) => {
          // Persist worker session with full tool call detail
          for (const msg of responseMessages) session.append(msg);
          sessionStore.save(session).then(() => {
            // Enrich worker session metadata for UI display
            sessionStore.updateMetadata(workerSessionKey, {
              channelType: "worker",
              agentId,
              agentName,
              ...(teamName ? { teamName } : {}),
            });
          }).catch((err) => {
            logger.warn(`[delegate] Failed to save worker session ${workerSessionKey}: ${err instanceof Error ? err.message : err}`);
          });

          // Close the worker's own browser instance
          cleanupWorkerBrowser(workerBrowser, agentName);

          channelStore.post(channelId, agentId, "result", result);
          delegationStore.markCompleted(delegationId, result);
          logger.info(`[delegate] ${agentName} completed (${result.length} chars, channel: ${channelId})`);

          emit("agent", {
            sessionKey,
            delegation: { agentId, agentName, channelId, status: "completed", resultLength: result.length },
          });

          onWorkerComplete(sessionKey, channelId);
        },
        (err) => {
          const error = err instanceof Error ? err.message : String(err);

          // Persist worker session even on failure for debugging
          sessionStore.save(session).then(() => {
            sessionStore.updateMetadata(workerSessionKey, {
              channelType: "worker",
              agentId,
              agentName,
              ...(teamName ? { teamName } : {}),
            });
          }).catch((saveErr) => {
            logger.warn(`[delegate] Failed to save worker session ${workerSessionKey}: ${saveErr instanceof Error ? saveErr.message : saveErr}`);
          });

          // Close the worker's own browser instance even on failure
          cleanupWorkerBrowser(workerBrowser, agentName);

          channelStore.post(channelId, agentId, "error", error);
          delegationStore.markFailed(delegationId, error);
          logger.error(`[delegate] ${agentName} failed: ${error} (channel: ${channelId})`);

          emit("agent", {
            sessionKey,
            delegation: { agentId, agentName, channelId, status: "failed", error },
          });

          onWorkerComplete(sessionKey, channelId);
        },
      );

      return `Delegated to ${agentName}. Channel: ${channelId}`;
    },
  });

  const listWorkers = tool({
    description: "List available worker names you can delegate tasks to.",
    inputSchema: z.object({}),
    execute: async () => {
      if (delegatable.length === 0) return "No workers available.";
      return `Available workers:\n${delegatable.map((name) => `- ${name}`).join("\n")}`;
    },
  });

  const workerGet = tool({
    description:
      "Get full configuration details for one worker by name (identity, tools, model, limits, subscriptions).",
    inputSchema: z.object({
      worker: z.string().describe("Worker name to inspect"),
    }),
    execute: async ({ worker }) => {
      const workerConfig = registry.getWorker(worker);
      if (!workerConfig) {
        return `Unknown worker: ${worker}. Call ${listWorkersToolName} to see available workers.`;
      }
      return formatWorkerDetails(workerConfig, workerGetToolName);
    },
  });

  const readChannel = createReadChannelTool(channelStore, idToName);

  return {
    delegate,
    list_workers: listWorkers,
    worker_get: workerGet,
    read_channel: readChannel,
  };
}

/** Standalone read_channel tool — reused by both orchestrator and workers. */
function createReadChannelTool(channelStore: ChannelStore, nameMap?: Map<string, string>) {
  return tool({
    description:
      "Read all messages from a delegation channel. Returns the full conversation log " +
      "including tasks, results, and errors posted by any agent.",
    inputSchema: z.object({
      channelId: z
        .string()
        .describe("The channel ID to read"),
    }),
    execute: async ({ channelId }) => {
      const messages = channelStore.read(channelId);
      if (messages.length === 0) return `Channel ${channelId}: no messages yet.`;

      return messages
        .map((m) => `[${nameMap?.get(m.sender) ?? m.sender}] (${m.role}): ${m.content}`)
        .join("\n\n");
    },
  });
}

const DEFAULT_WORKER_MAX_STEPS = 20;

/** Run a worker's loop — returned promise settles when done. */
async function runWorker(
  agentId: string,
  agentName: string,
  model: Parameters<typeof runLoop>[0]["model"],
  provider: string,
  modelId: string,
  codexReasoningEffort: CodexReasoningEffort | undefined,
  system: string,
  session: Session,
  tools: ToolSet,
  workerSessionKey: string,
  maxSteps?: number,
  sessionLabel?: string,
  sandboxEnabled = false,
): Promise<{ text: string; responseMessages: ModelMessage[] }> {
  let cleanup: (() => Promise<void>) | undefined;
  try {
    const adapted = await adaptTools(provider, modelId, model, tools, {
      sandboxEnabled,
      codexReasoningEffort,
    });
    cleanup = adapted.cleanup;
    return await runLoop({
      model: adapted.model,
      system,
      messages: session.getMessages(),
      tools: adapted.tools,
      sessionKey: workerSessionKey,
      sessionLabel,
      agentId,
      maxSteps: maxSteps ?? DEFAULT_WORKER_MAX_STEPS,
      silent: true,
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error(`[delegate] ${agentName} worker failed: ${error}`);
    throw err;
  } finally {
    if (cleanup) {
      try {
        await cleanup();
      } catch (err) {
        logger.warn(`[delegate] ${agentName} worker MCP cleanup failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
}

/** Close the browser if the worker had it open. No-op if no browser or already closed. */
function cleanupWorkerBrowser(browserManager: BrowserManager | null, agentName: string): void {
  if (!browserManager?.isLaunched()) return;
  browserManager.close().catch((err) => {
    logger.warn(`[delegate] ${agentName} browser cleanup failed: ${err instanceof Error ? err.message : err}`);
  });
}

function formatWorkerDetails(
  worker: {
    id: string;
    name: string;
    model: string;
    contextWindow: number;
    maxSteps: number;
    identity: string;
    tools: string[];
    timeout: number;
    templateId?: string | null;
    subscriptions: string[];
    concurrency: number;
  },
  workerGetToolName: string,
): string {
  const toolsList = worker.tools.length > 0 ? worker.tools.join(", ") : "(all tools)";
  const subscriptionsList = worker.subscriptions.length > 0 ? worker.subscriptions.join(", ") : "(none)";
  const templateId = worker.templateId ?? "(none)";
  const identity = worker.identity.trim() || "(empty)";

  return [
    `Worker: ${worker.name}`,
    `- id: ${worker.id}`,
    `- model: ${worker.model}`,
    `- contextWindow: ${worker.contextWindow}`,
    `- maxSteps: ${worker.maxSteps}`,
    `- timeoutSeconds: ${worker.timeout}`,
    `- concurrency: ${worker.concurrency}`,
    `- subscriptions: ${subscriptionsList}`,
    `- templateId: ${templateId}`,
    `- tools: ${toolsList}`,
    `- identity:`,
    identity,
    "",
    `Tip: use ${workerGetToolName} with another name to inspect a different worker.`,
  ].join("\n");
}

/** Race a promise against a timeout. */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}
