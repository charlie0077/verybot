import type { ToolSet } from "ai";
import type { Config } from "../config.js";
import type { MemoryStore } from "../memory/store.js";
import type { EmbeddingProvider } from "../memory/embedding.js";
import type { DockerSandbox } from "../security/docker-sandbox.js";
import type { SkillManager } from "../skills/loader.js";
import type { IntegrationRegistry } from "../integrations/registry.js";
import type { ScheduleStore } from "../scheduler/store.js";
import type { DesktopAdapter } from "../computer/desktop/adapter.js";
import type { BrowserManager } from "../computer/browser/manager.js";
import type { AgentRegistry } from "./agent-registry.js";
import type { ChannelStore } from "./channel-store.js";
import type { DelegationStore } from "./delegation-store.js";
import type { SessionStore } from "./session-store.js";
import { createBashTool } from "../tools/bash.js";
import { createMemorySearchTool, createMemorySaveTool } from "../tools/memory.js";
import { createDesktopTool } from "../computer/desktop/tools.js";
import { createBrowserTools } from "../computer/browser/tools.js";
import { createSpeakTools } from "../tools/speak.js";
import { createDelegationTools } from "../tools/delegate.js";
import { createIntegrationToggleTools } from "../tools/integration-toggle.js";
import { createScheduleTools } from "../tools/schedule.js";
import { createTaskTools } from "../tools/tasks.js";
import { createScopedWorkerManagementTools, createTeamManagementTools } from "../tools/teams.js";
import { createPromptTemplateTools } from "../tools/prompt-templates.js";
import { createChannelHistoryTool } from "../tools/channel-history.js";
import type { TaskStore } from "../tasks/store.js";
import type { TeamStore } from "../teams/store.js";
import type { PromptTemplateStore } from "../prompt-templates/store.js";
import type { ChannelManager } from "../channels/manager.js";
import { DEFAULT_TEAM_ID } from "../config/agent-config.js";
import { logger } from "../logger.js";

export type RunAgentRole = "orchestrator" | "worker";
/** All dependencies needed to build per-run tools. */
export interface RunToolsDeps {
  baseTools: ToolSet;
  config: Config;
  memoryStore: MemoryStore | null;
  embeddingProvider: EmbeddingProvider | null;
  memoryMaxResults: number;
  sandbox: DockerSandbox | null;
  skillManager: SkillManager;
  integrationRegistry: IntegrationRegistry;
  scheduleStore: ScheduleStore | null;
  taskStore: TaskStore | null;
  teamStore: TeamStore | null;
  promptTemplateStore: PromptTemplateStore | null;
  desktopAdapter: DesktopAdapter | null;
  browserManager: BrowserManager | null;
  /** Effective model string ("provider:id") for the current run — may differ from global config when inside a team. */
  effectiveModel: string;
  agentRegistry: AgentRegistry | null;
  delegationStore: DelegationStore | null;
  channelStore: ChannelStore | null;
  channelManager: ChannelManager | null;
  sessionStore: SessionStore;
  modelId: string;
  onWorkerComplete: (sessionKey: string, channelId: string) => void;
}

/** Build the per-run tool set based on current session state. */
export function buildRunTools(
  deps: RunToolsDeps,
  sessionKey: string,
  activeIntegrations: Set<string>,
  channelInfo?: { channelType: string; channelId: string },
  agentId?: string,
  agentRole?: RunAgentRole,
  teamId?: string,
  scheduleTeamId?: string,
  sessionLabel?: string,
  workspaceCwd?: string,
  agentToolAllowlist?: string[],
): ToolSet {
  const enforceWorkerAllowlist =
    agentRole === "worker" &&
    Array.isArray(agentToolAllowlist) &&
    agentToolAllowlist.length > 0;
  const allowedToolNames = new Set(agentToolAllowlist ?? []);
  const isAllowed = (toolName: string): boolean =>
    !enforceWorkerAllowlist || allowedToolNames.has(toolName);
  const mergeAllowedTools = (extraTools: ToolSet): void => {
    for (const [toolName, toolDef] of Object.entries(extraTools)) {
      if (!isAllowed(toolName)) continue;
      tools[toolName] = toolDef;
    }
  };

  const tools: ToolSet = { ...deps.baseTools };

  // Rebuild browser tools per run so browser actions are bound to the current session key.
  if (deps.browserManager) {
    const browserSessionKey = deps.config.browserMode === "per-tab-per-session" ? sessionKey : undefined;
    mergeAllowedTools(createBrowserTools(deps.browserManager, browserSessionKey));
    if (browserSessionKey) {
      logger.debug(`[${sessionLabel}] Browser tools bound to session key: ${browserSessionKey}`);
    }
  }

  // Session-scoped bash tool (needs sessionKey for sandbox container routing)
  const bashTool = createBashTool(deps.config.bash, {
    sessionKey,
    sandbox: deps.sandbox,
    cwd: workspaceCwd,
  });
  if (bashTool && isAllowed("bash")) tools.bash = bashTool;

  // When sandbox is enabled, remove fs tools — bash inside the container covers these
  if (deps.sandbox) {
    for (const name of ["read", "write", "edit", "grep", "find", "ls"]) {
      delete tools[name];
    }
  }

  if (deps.memoryStore) {
    // Scope memory to team when talking to a non-default team
    const memoryTeamId = teamId && teamId !== DEFAULT_TEAM_ID ? teamId : undefined;
    if (isAllowed("memory_search")) {
      tools.memory_search = createMemorySearchTool(
        deps.memoryStore,
        deps.embeddingProvider,
        deps.memoryMaxResults,
        memoryTeamId,
      );
    }
    if (isAllowed("memory_save")) {
      tools.memory_save = createMemorySaveTool(
        deps.memoryStore,
        deps.embeddingProvider,
        sessionKey,
        memoryTeamId,
      );
    }
  }

  // Desktop tool — rebuilt per-run to track model/config changes
  if (deps.config.desktop.enabled && deps.desktopAdapter) {
    if (isAllowed("computer")) {
      tools.computer = createDesktopTool(deps.desktopAdapter, deps.modelId);
    }
  }

  // TTS tools — rebuilt per-run so enabling/disabling takes effect immediately
  const ttsTools = createSpeakTools(deps.config.tts);
  if (ttsTools) mergeAllowedTools(ttsTools);

  // Dynamic read_skill tool (reflects latest SkillManager state after hot-reload)
  const readSkill = deps.skillManager.readTool;
  if (readSkill && isAllowed("read_skill")) tools.read_skill = readSkill;

  // Integration tools (only for active integrations)
  mergeAllowedTools(deps.integrationRegistry.getToolsFor(activeIntegrations));

  // Enable/disable integration tools (always present if integrations exist)
  if (deps.integrationRegistry.names.length > 0) {
    mergeAllowedTools(createIntegrationToggleTools(deps.integrationRegistry, activeIntegrations));
  }

  // Delegation tools (only for orchestrators with workers)
  if (agentRole === "orchestrator" && agentId && deps.agentRegistry && deps.delegationStore && deps.channelStore) {
    const workers = deps.agentRegistry.delegatableWorkers();
    if (workers.length > 0) {
      Object.assign(tools, createDelegationTools(
        deps.agentRegistry,
        deps.channelStore,
        deps.delegationStore,
        deps.sessionStore,
        agentId,
        sessionKey,
        deps.memoryStore,
        deps.embeddingProvider,
        deps.memoryMaxResults,
        deps.onWorkerComplete,
        deps.browserManager
          ? {
              headless: deps.config.browserHeadless,
              userAgent: deps.config.browserUserAgent || undefined,
              mode: deps.config.browserMode,
              modeOptions: deps.config.browserModeOptions,
            }
          : null,
        sessionLabel,
        !!deps.sandbox,
      ));
    }
  }

  // Task tools — scoped to team when talking to a specific team, with team's custom statuses
  if (deps.taskStore) {
    const teamStatuses = teamId && deps.teamStore
      ? deps.teamStore.getTeamById(teamId)?.statuses ?? undefined
      : undefined;
    mergeAllowedTools(createTaskTools(deps.taskStore, teamId, teamStatuses, {
      updatedBy: agentId ?? "assistant",
    }));
  }

  // Team management tools:
  // - default runtime: full team management
  // - non-default orchestrator: worker CRUD scoped to its own team
  const isDefaultRuntimeTeam = !teamId || teamId === DEFAULT_TEAM_ID;
  if (deps.teamStore) {
    if (isDefaultRuntimeTeam) {
      mergeAllowedTools(createTeamManagementTools(deps.teamStore, DEFAULT_TEAM_ID, deps.promptTemplateStore ?? undefined));
    } else if (agentRole === "orchestrator") {
      mergeAllowedTools(createScopedWorkerManagementTools(deps.teamStore, teamId, deps.promptTemplateStore ?? undefined));
    }
  }

  // Prompt template tools stay on the default runtime only.
  if (isDefaultRuntimeTeam && deps.promptTemplateStore) {
    mergeAllowedTools(createPromptTemplateTools(deps.promptTemplateStore));
  }

  // Schedule management tools (team-scoped — uses separate scheduleTeamId to avoid default-team regression)
  const effectiveScheduleTeamId = scheduleTeamId ?? teamId;
  if (deps.scheduleStore && effectiveScheduleTeamId) {
    mergeAllowedTools(createScheduleTools(deps.scheduleStore, effectiveScheduleTeamId, deps.integrationRegistry.names));
  }

  // Channel history tool — lets the LLM read recent messages on demand.
  // Uses a resolver callback so the channelId is read fresh at execution time,
  // not captured in a stale closure at tool creation time.
  if (channelInfo && deps.channelManager) {
    const { channelType, channelId } = channelInfo;
    const historyTool = createChannelHistoryTool(
      deps.channelManager,
      channelType,
      () => channelId,
    );
    if (historyTool && isAllowed("read_channel_history")) tools.read_channel_history = historyTool;
  }

  return tools;
}
