import type { WebSocket } from "ws";
import type { Agent } from "../brain/agent.js";
import type { ConfigStore } from "../config/store.js";
import type { TaskStore } from "../tasks/store.js";
import type { TeamStore } from "../teams/store.js";
import type { ScheduleStore } from "../scheduler/store.js";
import type { ConnectedChannelRegistry } from "../scheduler/connected-channels.js";
import type { MemoryStore } from "../memory/store.js";
import type { EmbeddingProvider } from "../memory/embedding.js";
import type { CommandAliasStore } from "../aliases/store.js";
import { chatMethods } from "./methods/chat.js";
import { sessionMethods } from "./methods/sessions.js";
import { configMethods } from "./methods/config.js";
import { systemMethods } from "./methods/system.js";
import { getVersion } from "../version.js";
import { taskMethods } from "./methods/tasks.js";
import { teamMethods } from "./methods/teams.js";
import { schedulerMethods } from "./methods/scheduler.js";
import { modelMethods } from "./methods/models.js";
import { toolMethods } from "./methods/tools.js";
import { whatsappMethods } from "./methods/whatsapp.js";
import type { PromptTemplateStore } from "../prompt-templates/store.js";
import { promptTemplateMethods } from "./methods/prompt-templates.js";
import { playbookMethods } from "./methods/playbooks.js";
import { aliasMethods } from "./methods/aliases.js";

type RpcMethod = (params: any) => Promise<unknown>;

/** Per-call context passed from the WS layer to RPC methods. */
export interface RpcContext {
  /** The WebSocket that initiated this RPC call. */
  ws: WebSocket;
}

export interface RpcOptions {
  configStore?: ConfigStore;
  /** Hot-restart callback: tears down current runtime and boots a new one. */
  restart?: () => Promise<void>;
  /** Getter for TaskStore (follows runtime swaps on hot restart). */
  getTaskStore?: () => TaskStore;
  /** Getter for TeamStore (follows runtime swaps on hot restart). */
  getTeamStore?: () => TeamStore;
  /** Getter for ScheduleStore (follows runtime swaps on hot restart). */
  getScheduleStore?: () => ScheduleStore;
  /** Getter for ConnectedChannelRegistry (follows runtime swaps on hot restart). */
  getConnectedChannels?: () => ConnectedChannelRegistry;
  /** Getter for MemoryStore (follows runtime swaps on hot restart). */
  getMemoryStore?: () => MemoryStore | null;
  /** Getter for EmbeddingProvider (follows runtime swaps on hot restart). */
  getEmbeddingProvider?: () => EmbeddingProvider | null;
  /** Getter for PromptTemplateStore (follows runtime swaps on hot restart). */
  getPromptTemplateStore?: () => PromptTemplateStore;
  /** Getter for global command alias store (follows runtime swaps on hot restart). */
  getCommandAliasStore?: () => CommandAliasStore;
}

export function createRpcDispatcher(getAgent: () => Agent, opts: RpcOptions = {}) {
  const {
    configStore,
    restart,
    getTaskStore,
    getTeamStore,
    getScheduleStore,
    getConnectedChannels,
    getMemoryStore,
    getEmbeddingProvider,
    getPromptTemplateStore,
    getCommandAliasStore,
  } = opts;

  const staticMethods: Record<string, RpcMethod> = {
    ...chatMethods(getAgent),
    ...sessionMethods(getAgent),
    ...(configStore ? configMethods(configStore, getAgent) : {}),
    ...modelMethods(),
    ...playbookMethods(),
    "system.version": async () => ({ version: getVersion() }),
  };

  return async (method: string, params: unknown, ctx?: RpcContext): Promise<unknown> => {
    // 1. Static methods (no ctx or hot-restart dependency)
    if (staticMethods[method]) return staticMethods[method](params);

    // 2. Tool methods (derived from Agent)
    if (method.startsWith("tools.")) {
      const methods = toolMethods(getAgent) as Record<string, RpcMethod>;
      if (methods[method]) return methods[method](params);
    }

    // 3. System methods (need ctx for per-client log subscriptions)
    if (restart && method.startsWith("system.")) {
      const methods = systemMethods(restart, ctx) as Record<string, RpcMethod>;
      if (methods[method]) return methods[method](params);
    }

    // 4. Task methods (lazy for hot-restart safety)
    if (getTaskStore && method.startsWith("tasks.")) {
      const methods = taskMethods(getTaskStore(), getTeamStore?.()) as Record<string, RpcMethod>;
      if (methods[method]) return methods[method](params);
    }

    // 5. Team methods (lazy for hot-restart safety)
    if (getTeamStore && method.startsWith("teams.")) {
      const methods = teamMethods(
        getTeamStore(),
        getMemoryStore?.() ?? null,
        getEmbeddingProvider?.() ?? null,
      ) as Record<string, RpcMethod>;
      if (methods[method]) return methods[method](params);
    }

    // 6. Prompt template methods (lazy for hot-restart safety)
    if (getPromptTemplateStore && method.startsWith("promptTemplates.")) {
      const methods = promptTemplateMethods(getPromptTemplateStore()) as Record<string, RpcMethod>;
      if (methods[method]) return methods[method](params);
    }

    // 7. Scheduler methods (lazy + ctx for hot-restart safety)
    if (getScheduleStore && getConnectedChannels && method.startsWith("scheduler.")) {
      const methods = schedulerMethods(getAgent, getScheduleStore, getConnectedChannels, ctx) as Record<string, RpcMethod>;
      if (methods[method]) return methods[method](params);
    }

    // 8. Command alias methods (global, file-backed)
    if (getCommandAliasStore && method.startsWith("aliases.")) {
      const methods = aliasMethods(getCommandAliasStore()) as Record<string, RpcMethod>;
      if (methods[method]) return methods[method](params);
    }

    // 9. WhatsApp methods (link/unlink/status)
    if (configStore && method.startsWith("whatsapp.")) {
      const methods = whatsappMethods(getAgent, configStore) as Record<string, RpcMethod>;
      if (methods[method]) return methods[method](params);
    }

    throw new Error(`Unknown method: ${method}`);
  };
}
