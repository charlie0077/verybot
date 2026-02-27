import type { AssistantModelMessage, LanguageModel, ToolSet } from "ai";
import type { IncomingMessage, Channel } from "../channels/types.js";
import type { Config } from "../config.js";
import { loadConfig, injectSecretsIntoEnv, hasConfiguredModel } from "../config.js";
import type { ConfigStore } from "../config/store.js";
import { INTEGRATIONS_DIR, MEMORY_DB_PATH } from "../paths.js";
import type { MemoryStore } from "../memory/store.js";
import type { EmbeddingProvider } from "../memory/embedding.js";
import type { CodexReasoningEffort } from "../config/model-spec.js";
import type { ModelDef } from "../config/model-catalog.js";
import { Session } from "./session.js";
import { SessionStore } from "./session-store.js";
import { MessageQueue } from "./queue.js";
import { buildSystemPrompt } from "./context.js";
import { runLoop } from "./loop.js";
import { getModel } from "./providers.js";
import { adaptTools } from "./mcp-adapter.js";
import { resolveModelDef } from "../config/model-catalog.js";
import { isContextOverflowError, estimateTokens, estimateStringTokens, compactSchedulerRuns, SCHEDULED_TASK_PREFIX } from "./compaction.js";
import { DEFAULT_SAFE_BINS } from "../security/command-validator.js";
import type { DockerSandbox } from "../security/docker-sandbox.js";
import type { SkillManager } from "../skills/loader.js";
import { IntegrationRegistry } from "../integrations/registry.js";
import type { ScheduleStore } from "../scheduler/store.js";
import type { ConnectedChannelRegistry } from "../scheduler/connected-channels.js";
import type { TaskStore } from "../tasks/store.js";
import type { TeamStore } from "../teams/store.js";
import type { PromptTemplateStore } from "../prompt-templates/store.js";
import { resolveInlineAttachmentContent } from "../tasks/inline-attachment-content.js";
import type { DesktopAdapter } from "../computer/desktop/adapter.js";
import { BrowserManager } from "../computer/browser/manager.js";
import { ChannelStore } from "./channel-store.js";
import { DelegationStore } from "./delegation-store.js";
import { AgentRegistry, TeamRegistry, parseModel, type TeamInfo } from "./agent-registry.js";
import { DEFAULT_TEAM_ID } from "../config/agent-config.js";
import { ChannelManager } from "../channels/manager.js";
import { buildChannelSpecs } from "../channels/specs.js";
import { buildUserMessageContent, mergeImageDataUrls } from "./user-content.js";
import type { MarkdownTableMode } from "../markdown/ir.js";
import { logger } from "../logger.js";
import { saveExplicitMemory, type SaveExplicitMemoryResult } from "../memory/explicit.js";
import { learnSessionMemories, type LearnSessionMemoriesResult } from "../memory/session-learning.js";

import { emit, on } from "../events.js";
import { buildSessionKey, parseSessionKey, deriveMemoryTeamId } from "./session-key.js";
import { setsEqual, friendlyError } from "./utils.js";
import { SessionStateMap, type SessionState } from "./session-state.js";
import { MemoryExtractor } from "./memory-extractor.js";
import { WorkerCoordinator } from "./worker-coordinator.js";
import { TaskSubscriberManager } from "./task-subscriber.js";
import { buildRunTools, type RunAgentRole, type RunToolsDeps } from "./run-tools.js";

/** Max compaction retries on context overflow before re-throwing. */
const MAX_COMPACTION_RETRIES = 3;

/** Skip compaction when estimated total tokens are below this fraction of the context window. */
const COMPACTION_SKIP_THRESHOLD = 0.6;

/** Session key suffix that identifies the team's shared scheduler session. */
const SCHEDULER_SESSION_SUFFIX = ":scheduler:main";

const MODEL_NOT_CONFIGURED_MESSAGE = "Model is not configured. Open Settings -> Agent and choose a model.";
const MODEL_NOT_CONFIGURED_REPLY =
  `${MODEL_NOT_CONFIGURED_MESSAGE} ` +
  "If Codex CLI or Claude CLI already works on this machine, select that provider in Settings -> Agent.";

interface ResolvedGlobalModel {
  model: LanguageModel;
  modelId: string;
  modelDef: ModelDef;
  configured: boolean;
}

function resolveGlobalModel(model: Config["model"]): ResolvedGlobalModel {
  if (!hasConfiguredModel(model)) {
    return {
      // Keep runtime bootable without a configured model so UI setup can proceed.
      model: {} as LanguageModel,
      modelId: "",
      modelDef: resolveModelDef("", model.contextWindow),
      configured: false,
    };
  }

  return {
    model: getModel(model.provider, model.id, {
      codexReasoningEffort: model.codexReasoningEffort,
    }),
    modelId: model.id,
    modelDef: resolveModelDef(model.id, model.contextWindow),
    configured: true,
  };
}

/** Per-run context passed to buildAdaptAndRun. */
interface RunContext {
  session: Session;
  sessionKey: string;
  system: string;
  abortSignal?: AbortSignal;
  teamScopedRegistry: AgentRegistry | null;
  activeIntegrations: Set<string>;
  channelInfo: { channelType: string; channelId: string };
  effectiveAgentId: string | undefined;
  effectiveAgentRole: RunAgentRole | undefined;
  taskTeamId: string | undefined;
  scheduleTeamId: string;
  workspaceCwd?: string;
  runBaseTools: ToolSet;
  runToolAllowlist?: string[];
  runProvider: string;
  runModelId: string;
  runCodexReasoningEffort?: CodexReasoningEffort;
  runModel: LanguageModel;
  contextWindow: number;
  maxSteps: number;
}

interface RunResponse {
  text: string;
  assistantContent: AssistantModelMessage["content"] | null;
}

export interface AgentDeps {
  config: Config;
  configStore: ConfigStore;
  tools: ToolSet;
  dataDir: string;
  memoryStore?: MemoryStore | null;
  embeddingProvider?: EmbeddingProvider | null;
  sandbox?: DockerSandbox | null;
  skillManager?: SkillManager;
  integrationRegistry?: IntegrationRegistry;
  scheduleStore?: ScheduleStore | null;
  taskStore?: TaskStore | null;
  desktopAdapter?: DesktopAdapter | null;
  browserManager?: BrowserManager | null;
  delegationStore?: DelegationStore | null;
  channelStore?: ChannelStore | null;
  teamStore?: TeamStore | null;
  promptTemplateStore?: PromptTemplateStore | null;
  channelManager?: ChannelManager | null;
  connectedChannels?: ConnectedChannelRegistry | null;
}

export class Agent {
  private sessions = new SessionStateMap();
  private sessionStore: SessionStore;
  private queue: MessageQueue;
  private model: LanguageModel;
  private modelId: string;
  private identity: string;
  private language: string;
  private tools: ToolSet;
  private modelDef: ModelDef;
  private memoryStore: MemoryStore | null;
  private embeddingProvider: EmbeddingProvider | null;
  private memoryMaxResults: number;
  private config: Config;
  private configStore: ConfigStore;
  private sandbox: DockerSandbox | null;
  private skillManager: SkillManager;
  private integrationRegistry: IntegrationRegistry;
  private scheduleStore: ScheduleStore | null;
  private taskStore: TaskStore | null;
  private desktopAdapter: DesktopAdapter | null;
  private browserManager: BrowserManager | null;
  private sessionBrowserManagers = new Map<string, BrowserManager>();
  private teamRegistry: TeamRegistry | null = null;
  private delegationStore: DelegationStore | null;
  private channelStore: ChannelStore | null;
  private teamStore: TeamStore | null;
  private promptTemplateStore: PromptTemplateStore | null;
  private channelManager: ChannelManager | null;
  private connectedChannels: ConnectedChannelRegistry | null;

  private lastConfigMtime: number | null = null;
  private teamRegistryDirty = false;
  private newSessionPending = false;
  private unsubTeamChange: (() => void) | null = null;
  private memoryExtractor: MemoryExtractor | null = null;
  private workerCoordinator: WorkerCoordinator;
  private taskSubscriber: TaskSubscriberManager | null = null;
  /** Cleanup functions for HTTP MCP servers (keyed by session key). */
  private mcpCleanups = new Map<string, () => Promise<void>>();

  constructor(deps: AgentDeps) {
    this.tools = deps.tools;
    this.sessionStore = new SessionStore(deps.dataDir);
    this.memoryStore = deps.memoryStore ?? null;
    this.embeddingProvider = deps.embeddingProvider ?? null;
    this.config = deps.config;
    this.configStore = deps.configStore;
    this.sandbox = deps.sandbox ?? null;
    this.skillManager = deps.skillManager ?? ({ systemPrompt: "", readTool: null } as SkillManager);
    this.integrationRegistry = deps.integrationRegistry ?? new IntegrationRegistry();
    this.scheduleStore = deps.scheduleStore ?? null;
    this.taskStore = deps.taskStore ?? null;
    this.desktopAdapter = deps.desktopAdapter ?? null;
    this.browserManager = deps.browserManager ?? null;
    this.delegationStore = deps.delegationStore ?? null;
    this.channelStore = deps.channelStore ?? null;
    this.teamStore = deps.teamStore ?? null;
    this.promptTemplateStore = deps.promptTemplateStore ?? null;
    this.channelManager = deps.channelManager ?? null;
    this.connectedChannels = deps.connectedChannels ?? null;

    // Apply config synchronously so fields are initialized immediately (no `!` assertions)
    const initialModel = resolveGlobalModel(deps.config.model);
    this.model = initialModel.model;
    this.modelId = initialModel.modelId;
    this.modelDef = initialModel.modelDef;
    if (!initialModel.configured) logger.warn(MODEL_NOT_CONFIGURED_MESSAGE);
    this.identity = deps.config.identity;
    this.language = deps.config.language;
    this.memoryMaxResults = deps.config.memory.maxResults;

    if (this.memoryStore) {
      this.memoryExtractor = new MemoryExtractor(this.model, this.memoryStore, this.embeddingProvider);
    }

    // Build team registry eagerly so getTeams() works before first message
    this.rebuildTeamRegistry();

    // Mark dirty when teams change so next main() call rebuilds the registry
    this.unsubTeamChange = on("teamChange", () => { this.teamRegistryDirty = true; });

    this.queue = new MessageQueue({
      mode: "collect",
      processMessage: (sessionKey, text, signal, images) => this.main(sessionKey, text, images, signal),
    });

    this.workerCoordinator = new WorkerCoordinator(this.sessions, this.queue);

    // Start pull-based task subscriber if both stores are available
    if (this.taskStore && this.teamStore) {
      this.taskSubscriber = new TaskSubscriberManager({
        taskStore: this.taskStore,
        teamStore: this.teamStore,
        sessionStore: this.sessionStore,
        memoryStore: this.memoryStore,
        embeddingProvider: this.embeddingProvider,
        memoryMaxResults: this.memoryMaxResults,
        config: deps.config,
        baseTools: this.tools,
        skillManager: this.skillManager,
        browserConfig: this.browserManager ? {
          headless: deps.config.browserHeadless,
          userAgent: deps.config.browserUserAgent || undefined,
          mode: deps.config.browserMode,
          modeOptions: deps.config.browserModeOptions,
        } : null,
        sandboxEnabled: !!this.sandbox,
      });
      this.taskSubscriber.start();
    }
  }

  /** Force an immediate config reload + channel reconciliation. */
  async forceConfigReload(): Promise<void> {
    this.lastConfigMtime = null;
    await this.reloadConfig();
  }

  getSession(key: string): Session | undefined {
    return this.sessions.get(key)?.session;
  }

  getStore(): SessionStore {
    return this.sessionStore;
  }

  /** Called from channels (Telegram, Discord, etc.) */
  async handleMessage(msg: IncomingMessage, channel: Channel, agentId?: string): Promise<void> {
    let sessionKey = `${msg.channelType}:${msg.channelId}`;

    try {
      const teamId = agentId
        ? this.teamRegistry?.resolveTeam(agentId)?.teamId
        : msg.teamId;
      if (!teamId) {
        throw new Error("Missing teamId for incoming channel message");
      }
      sessionKey = buildSessionKey(teamId, msg.channelType, msg.channelId);
      const text = msg.text ?? "";

      // Eagerly create session so agentId + replyCallback are set before the queue runs
      const state = await this.getOrCreateSession(sessionKey);
      state.teamId = teamId;
      state.channelType = msg.channelType;
      state.channelId = msg.channelId;

      this.applyAgentBinding(state, sessionKey, agentId);
      if (!state.replyCallback) {
        state.replyCallback = (reply) => this.deliverReply(msg, channel, reply);
      }

      const reply = await this.queue.enqueue(sessionKey, text);
      if (reply) await this.deliverReply(msg, channel, reply);
    } catch (err) {
      logger.error(`Agent error [${this.sessionLabel(sessionKey)}]: ${err}`);
      const userMsg = friendlyError(err);
      emit("chat", {
        sessionKey,
        state: "final",
        message: { role: "assistant", content: userMsg },
      });
      try {
        await channel.send(msg.channelId, userMsg);
      } catch (sendErr) {
        logger.error(`Failed to send error to user [${this.sessionLabel(sessionKey)}]: ${sendErr}`);
      }
    }
  }

  /** Deliver reply as text or voice based on TTS reply mode. */
  private async deliverReply(
    msg: IncomingMessage,
    channel: Channel,
    reply: string,
  ): Promise<void> {
    const { replyMode } = this.config.tts;
    const shouldVoice =
      this.config.tts.enabled &&
      channel.sendVoice &&
      (replyMode === "voice" || (replyMode === "inbound" && msg.isVoice));

    if (shouldVoice) {
      try {
        const { synthesize } = await import("../tts/edge.js");
        const audioPath = await synthesize(reply);
        await channel.sendVoice!(msg.channelId, audioPath);
      } catch (err) {
        logger.error(`Voice reply failed, falling back to text: ${err instanceof Error ? err.message : err}`);
      }
    }
    await channel.send(msg.channelId, reply);
  }

  /** Called from gateway RPC (WebSocket UI) */
  async handleGatewayMessage(sessionKey: string, text: string, agentId?: string, images?: string[]): Promise<string> {
    try {
      const state = await this.getOrCreateSession(sessionKey);
      const parsed = parseSessionKey(sessionKey);
      const parts = sessionKey.split(":");
      if (!parsed.teamId) {
        throw new Error("sessionKey must include a teamId");
      }
      state.teamId = parsed.teamId;
      state.channelType = parsed.channelType ?? "gateway";
      state.channelId =
        !parsed.isWorker && parts.length >= 3
          ? parts.slice(2).join(":")
          : sessionKey;
      this.applyAgentBinding(state, sessionKey, agentId);
      return await this.queue.enqueue(sessionKey, text, images);
    } catch (err) {
      logger.error(`Gateway error [${this.sessionLabel(sessionKey)}]: ${err}`);
      const errorReply = friendlyError(err);
      // Emit a "chat" final event so the WebSocket UI renders the error
      // instead of hanging on a loading state.
      emit("chat", {
        sessionKey,
        agentId,
        state: "final",
        message: { role: "assistant", content: errorReply },
      });
      return errorReply;
    }
  }

  /** Validate and bind an agentId to an existing session state. */
  private applyAgentBinding(state: SessionState, sessionKey: string, agentId?: string): void {
    if (!agentId) return;

    // Validate using the team ID already set on the state (derived from session key),
    // not via resolveTeam(agentId) which can collide across teams.
    if (this.teamRegistry && state.teamId) {
      const registry = this.teamRegistry.getTeamRegistry(state.teamId);
      if (!registry) {
        logger.warn(`[${this.sessionLabel(sessionKey)}] Unknown team "${this.teamLabel(state.teamId)}" — ignoring agentId`);
        return;
      }

      // Allow binding to this team's orchestrator OR one of its workers.
      const teamAgentIds = registry.buildIdToNameMap();
      if (!teamAgentIds.has(agentId)) {
        logger.warn(
          `[${this.sessionLabel(sessionKey)}] agentId "${agentId}" does not belong to team "${this.teamLabel(state.teamId)}" — ignoring`,
        );
        return;
      }
    }
    if (state.agentId && state.agentId !== agentId) {
      logger.warn(`[${this.sessionLabel(sessionKey)}] Ignoring agentId change from "${state.agentId}" to "${agentId}" — clear session first`);
    } else if (!state.agentId) {
      state.agentId = agentId;
    }
  }

  /** Return teams for the UI picker. Reads from TeamStore for immediate visibility. */
  getTeams(): TeamInfo[] {
    if (!this.teamStore) return [];

    const teamConfigs = this.teamStore.toTeamConfigs();
    return teamConfigs.map((t) => ({
      id: t.id,
      name: t.name ?? t.id,
      color: t.color ?? "",
      orchestratorId: t.orchestrator.id,
      orchestratorIdentity: t.orchestrator.identity,
      orchestratorModel: t.orchestrator.model ? parseModel(t.orchestrator.model).modelId : "",
      workerCount: t.workers.length,
      workers: t.workers.map((w) => ({
        id: w.id,
        name: w.name,
        subscriptions: w.subscriptions ?? [],
        concurrency: w.concurrency ?? 1,
      })),
      statuses: t.statuses,
    }));
  }

  /** Abort current run for a session. */
  abortSession(sessionKey: string): boolean {
    return this.queue.abort(sessionKey);
  }

  /** Clear conversation history (memories are preserved across clears). */
  async clearSession(sessionKey: string): Promise<void> {
    logger.info(`Clearing session ${sessionKey}`);
    // Extract any remaining facts in background — don't block the clear
    const state = this.sessions.get(sessionKey);
    if (this.memoryExtractor && state && state.messagesSinceExtraction > 0) {
      const messages = state.session.getMessages();
      this.memoryExtractor.extractAndSaveFacts(sessionKey, messages, deriveMemoryTeamId(sessionKey)).catch((err) => {
        logger.warn(`Pre-clear extraction failed: ${err instanceof Error ? err.message : err}`);
      });
    }

    this.sessions.delete(sessionKey);
    this.queue.deleteLane(sessionKey);
    await this.sessionStore.clear(sessionKey);

    const sessionBrowser = this.sessionBrowserManagers.get(sessionKey);
    if (sessionBrowser) {
      this.sessionBrowserManagers.delete(sessionKey);
      try {
        await sessionBrowser.close();
        logger.debug(`Closed per-session browser for ${sessionKey}`);
      } catch (err) {
        logger.warn(`Failed to close per-session browser: ${err}`);
      }
    }

    // NEW: Clean up browser pages for this session
    if (this.browserManager && this.config.browserMode === "per-tab-per-session") {
      try {
        await this.browserManager.clearSessionPages(sessionKey);
        logger.debug(`Cleaned up browser pages for session ${sessionKey}`);
      } catch (err) {
        logger.warn(`Failed to clean browser pages: ${err}`);
      }
    }

    // Shut down any HTTP MCP server for this session
    const cleanup = this.mcpCleanups.get(sessionKey);
    if (cleanup) {
      this.mcpCleanups.delete(sessionKey);
      await cleanup();
    }
  }

  /** Clear old sessions while keeping the newest N sessions (optionally within a team). */
  async clearOldSessions(keepLatest: number, teamId?: string): Promise<number> {
    if (!Number.isInteger(keepLatest) || keepLatest < 0) {
      throw new Error("keepLatest must be a non-negative integer");
    }

    const scopedSessions = this.sessionStore
      .list()
      .filter((entry) => {
        if (!teamId) return true;
        const sessionTeamId = entry.teamId ?? parseSessionKey(entry.key).teamId;
        return sessionTeamId === teamId;
      });

    const staleSessionKeys = scopedSessions
      .slice(keepLatest)
      .map((entry) => entry.key);

    for (const sessionKey of staleSessionKeys) {
      await this.clearSession(sessionKey);
    }

    return staleSessionKeys.length;
  }

  /** Save one explicit fact into long-term memory for a session. */
  async rememberMemory(sessionKey: string, fact: string): Promise<SaveExplicitMemoryResult> {
    if (!this.memoryStore) {
      throw new Error("Memory is not enabled");
    }
    return saveExplicitMemory(this.memoryStore, this.embeddingProvider, {
      fact,
      source: sessionKey,
      teamId: deriveMemoryTeamId(sessionKey),
    });
  }

  /** Save one explicit fact from a channel command (team-aware). */
  async rememberChannelMemory(
    channelType: string,
    channelId: string,
    fact: string,
    teamId?: string,
  ): Promise<SaveExplicitMemoryResult> {
    if (!teamId) throw new Error("teamId is required");
    const sessionKey = buildSessionKey(teamId, channelType, channelId);
    return this.rememberMemory(sessionKey, fact);
  }

  /** Auto-learn facts from the current session, optionally filtered by topic. */
  async learnMemory(sessionKey: string, topic?: string): Promise<LearnSessionMemoriesResult> {
    if (!this.memoryStore) {
      throw new Error("Memory is not enabled");
    }
    const state = await this.getOrCreateSession(sessionKey);
    const model = this.resolveLearningModel(sessionKey);
    return learnSessionMemories({
      model,
      memoryStore: this.memoryStore,
      embeddingProvider: this.embeddingProvider,
      sessionKey,
      messages: state.session.getMessages(),
      teamId: deriveMemoryTeamId(sessionKey),
      topic,
    });
  }

  /** Auto-learn facts from channel session context. */
  async learnChannelMemory(
    channelType: string,
    channelId: string,
    topic?: string,
    teamId?: string,
  ): Promise<LearnSessionMemoriesResult> {
    if (!teamId) throw new Error("teamId is required");
    const sessionKey = buildSessionKey(teamId, channelType, channelId);
    return this.learnMemory(sessionKey, topic);
  }

  /**
   * Run a scheduled task in a persistent scheduler session. Returns the raw LLM reply.
   * Serialized through the message queue to avoid races with human messages.
   * The caller (Scheduler) handles [SKIP] detection and channel delivery.
   */
  async runScheduledTask(opts: {
    prompt: string;
    teamId: string;
    integrations: string[];
  }): Promise<string> {
    const schedulerKey = `${opts.teamId}${SCHEDULER_SESSION_SUFFIX}`;
    const state = await this.getOrCreateSession(schedulerKey);
    state.teamId = opts.teamId;
    state.channelType = "scheduler";
    state.channelId = "main";

    // Store integrations for this scheduled run so main() can pick them up
    state.scheduledIntegrations = opts.integrations;

    return this.queue.enqueue(schedulerKey, `${SCHEDULED_TASK_PREFIX} ${opts.prompt}`);
  }

  /**
   * Handle a human message sent to the scheduler session.
   * Serialized via the message queue to avoid overlap with scheduled task executions.
   */
  async handleSchedulerMessage(teamId: string, text: string, senderInfo?: string): Promise<string> {
    const schedulerKey = `${teamId}${SCHEDULER_SESSION_SUFFIX}`;
    const state = await this.getOrCreateSession(schedulerKey);
    state.teamId = teamId;
    state.channelType = "scheduler";
    state.channelId = "main";

    const prefixed = senderInfo ? `[${senderInfo}] ${text}` : text;
    return this.queue.enqueue(schedulerKey, prefixed);
  }

  /** Get the scheduler session for a team (for history display). */
  getSchedulerSession(teamId: string): Session | undefined {
    const schedulerKey = `${teamId}${SCHEDULER_SESSION_SUFFIX}`;
    return this.sessions.get(schedulerKey)?.session;
  }


  /** Start initial channels based on current config. Called once at boot. */
  async initChannels(): Promise<void> {
    await this.reconcileChannels(this.config);
  }

  /** Clean up sandbox containers. */
  cleanupSandbox(): void {
    this.sandbox?.cleanupAll();
  }

  /** Extract remaining facts from all active sessions (call before shutdown). */
  async flushMemories(): Promise<void> {
    if (this.memoryExtractor) {
      await this.memoryExtractor.flushAll(this.sessions);
    }
    this.workerCoordinator.clearAllTimers();
    this.taskSubscriber?.stop();
    this.unsubTeamChange?.();

    // Shut down all HTTP MCP servers
    const cleanups = [...this.mcpCleanups.values()];
    this.mcpCleanups.clear();
    await Promise.allSettled(cleanups.map((fn) => fn()));

    await this.closeAllSessionBrowsers();
  }

  private async getOrCreateSession(key: string): Promise<SessionState> {
    const existing = this.sessions.get(key);
    if (existing) return existing;

    this.newSessionPending = true;

    const session = await this.sessionStore.load(key) ?? new Session(key);
    const state = this.sessions.getOrCreate(key, session);
    // Seed token estimate from restored messages so compaction skip check is accurate
    if (session.messageCount > 0) {
      state.estimatedMsgTokens = estimateTokens(session.getMessages());
    }
    return state;
  }

  /** Build tools, adapt for MCP providers, and run the inference loop. */
  private async buildAdaptAndRun(opts: RunContext): Promise<RunResponse> {
    const label = this.sessionLabel(opts.sessionKey);
    const deps = this.buildRunToolsDeps(
      opts.teamScopedRegistry,
      `${opts.runProvider}:${opts.runModelId}`,
      this.getRunBrowserManager(opts.sessionKey),
      opts.runBaseTools,
    );
    let tools = buildRunTools(
      deps, opts.sessionKey, opts.activeIntegrations, opts.channelInfo,
      opts.effectiveAgentId, opts.effectiveAgentRole, opts.taskTeamId, opts.scheduleTeamId, label, opts.workspaceCwd,
      opts.runToolAllowlist,
    );

    // Clean up any previous MCP server, then adapt for MCP-based providers
    const prevCleanup = this.mcpCleanups.get(opts.sessionKey);
    if (prevCleanup) {
      this.mcpCleanups.delete(opts.sessionKey);
      await prevCleanup();
    }
    const adapted = await adaptTools(opts.runProvider, opts.runModelId, opts.runModel, tools, {
      sandboxEnabled: !!this.sandbox,
      codexReasoningEffort: opts.runCodexReasoningEffort,
      cwd: opts.workspaceCwd,
    });
    if (adapted.cleanup) this.mcpCleanups.set(opts.sessionKey, adapted.cleanup);
    tools = adapted.tools;

    return this.runLoopWithRetry(
      opts.session, opts.system, tools, opts.sessionKey,
      adapted.model, opts.contextWindow, opts.maxSteps, opts.abortSignal,
    );
  }

  /** Build the RunToolsDeps from current agent state (agentRegistry filled per-call). */
  private buildRunToolsDeps(
    agentRegistry: AgentRegistry | null,
    effectiveModel?: string,
    browserManager?: BrowserManager | null,
    baseTools?: ToolSet,
  ): RunToolsDeps {
    const configuredGlobalModel = hasConfiguredModel(this.config.model)
      ? `${this.config.model.provider}:${this.config.model.id}`
      : "";
    return {
      baseTools: baseTools ?? this.tools,
      config: this.config,
      memoryStore: this.memoryStore,
      embeddingProvider: this.embeddingProvider,
      memoryMaxResults: this.memoryMaxResults,
      sandbox: this.sandbox,
      skillManager: this.skillManager,
      integrationRegistry: this.integrationRegistry,
      scheduleStore: this.scheduleStore,
      taskStore: this.taskStore,
      teamStore: this.teamStore,
      promptTemplateStore: this.promptTemplateStore,
      desktopAdapter: this.desktopAdapter,
      browserManager: browserManager ?? this.browserManager,
      effectiveModel: effectiveModel ?? configuredGlobalModel,
      agentRegistry,
      delegationStore: this.delegationStore,
      channelStore: this.channelStore,
      channelManager: this.channelManager,
      sessionStore: this.sessionStore,
      modelId: this.modelId,
      onWorkerComplete: this.workerCoordinator.onWorkerComplete.bind(this.workerCoordinator),
    };
  }

  /** Return all tool names available in the current config (for UI discovery). */
  getToolNames(): string[] {
    const deps = this.buildRunToolsDeps(null);
    const tools = buildRunTools(deps, "__discovery__", new Set());
    return Object.keys(tools);
  }

  /** Run the loop with compaction retries on context overflow. */
  private async runLoopWithRetry(
    session: Session,
    system: string,
    tools: ToolSet,
    sessionKey: string,
    model?: LanguageModel,
    contextWindow?: number,
    maxSteps?: number,
    abortSignal?: AbortSignal,
  ): Promise<RunResponse> {
    const effectiveModel = model ?? this.model;
    const effectiveContextWindow = contextWindow ?? this.modelDef.contextWindow;
    const effectiveMaxSteps = maxSteps && maxSteps > 0 ? maxSteps : this.config.model.maxSteps;
    for (let attempt = 1; attempt <= MAX_COMPACTION_RETRIES + 1; attempt++) {
      try {
        const { text, assistantContent } = await runLoop({
          model: effectiveModel,
          system,
          messages: session.getMessages(),
          tools,
          sessionKey,
          abortSignal,
          sessionLabel: this.sessionLabel(sessionKey),
          maxSteps: effectiveMaxSteps,
        });
        return { text, assistantContent };
      } catch (err) {
        if (!isContextOverflowError(err) || attempt > MAX_COMPACTION_RETRIES) {
          throw err;
        }
        logger.warn(
          `Context overflow on attempt ${attempt}/${MAX_COMPACTION_RETRIES}, forcing compaction`,
        );
        const compacted = await session.compact(effectiveModel, effectiveContextWindow, system);
        if (!compacted) {
          logger.warn("Compaction had no effect, emergency truncating to last 10 messages");
          session.truncate(10);
        }
      }
    }
    throw new Error("Unreachable: all compaction retries exhausted");
  }

  /** (Re)build team registry from TeamStore (or skip if no store). */
  private rebuildTeamRegistry(): void {
    if (!this.teamStore) {
      this.teamRegistry = null;
      return;
    }
    const teamConfigs = this.teamStore.toTeamConfigs();
    if (teamConfigs.length === 0) {
      this.teamRegistry = null;
      return;
    }
    this.teamRegistry = new TeamRegistry(teamConfigs, {
      memoryStore: this.memoryStore,
      embeddingProvider: this.embeddingProvider,
      baseTools: this.tools,
      config: this.config,
    });
  }

  /** Reload config from disk so API key / model changes take effect immediately. */
  private async reloadConfig(): Promise<void> {
    // Skip reload if config file hasn't changed — unless it's a new session
    const mtime = this.configStore.mtime();
    if (!this.newSessionPending && mtime !== null && mtime === this.lastConfigMtime) return;
    this.lastConfigMtime = mtime;
    logger.info(`Reloading config`);

    injectSecretsIntoEnv(this.configStore);
    const previousMode = this.config.browserMode;
    const fresh = loadConfig(this.configStore);

    const resolvedModel = resolveGlobalModel(fresh.model);
    this.model = resolvedModel.model;
    this.modelId = resolvedModel.modelId;
    this.modelDef = resolvedModel.modelDef;
    if (!resolvedModel.configured) logger.warn(MODEL_NOT_CONFIGURED_MESSAGE);
    this.identity = fresh.identity;
    this.language = fresh.language;
    this.memoryMaxResults = fresh.memory.maxResults;
    this.config = fresh;

    if (previousMode === "per-browser-per-session" && fresh.browserMode !== "per-browser-per-session") {
      await this.closeAllSessionBrowsers();
    }
    if (previousMode !== "per-browser-per-session" && fresh.browserMode === "per-browser-per-session") {
      await this.browserManager?.close();
    }

    // Update memory extractor model
    this.memoryExtractor?.setModel(this.model);

    // Push browser config changes so next launch uses fresh values
    await this.browserManager?.updateConfig({
      headless: fresh.browserHeadless,
      userAgent: fresh.browserUserAgent || undefined,
      mode: fresh.browserMode,
      modeOptions: fresh.browserModeOptions,
    });

    if (fresh.browserMode === "per-browser-per-session") {
      const perSessionConfig = this.buildPerSessionBrowserConfig(fresh);
      for (const manager of this.sessionBrowserManagers.values()) {
        await manager.updateConfig(perSessionConfig);
      }
    }

    // Hot-reload channels in background (non-blocking)
    this.reconcileChannels(fresh).catch((err) => {
      logger.error(`Channel reconcile failed: ${err instanceof Error ? err.message : err}`);
    });
  }

  /**
   * Build channel specs from config and reconcile with ChannelManager.
   * Handlers use dynamic orchestrator lookup (reads this.config at call time)
   * so orchestrator-only changes don't require a channel restart.
   */
  private async reconcileChannels(config: Config): Promise<void> {
    if (!this.channelManager) return;

    const specs = buildChannelSpecs(config, {
      onMessage: (msg, ch) => this.handleMessage(msg, ch),
      onClear: async (channelType, channelId, teamId) => {
        if (!teamId) throw new Error("teamId is required");
        await this.clearSession(buildSessionKey(teamId, channelType, channelId));
      },
      onLearn: (channelType, channelId, topic, teamId) =>
        this.learnChannelMemory(channelType, channelId, topic, teamId),
      onRemember: (channelType, channelId, fact, teamId) =>
        this.rememberChannelMemory(channelType, channelId, fact, teamId),
      listTeams: () => this.getTeams().map((t) => ({ id: t.id, name: t.name })),
      connectedChannels: this.connectedChannels,
      getChannelTableConfig: (channel) =>
        (this.config.channels as Record<string, { markdown?: { tables?: MarkdownTableMode } } | undefined>)[channel]
          ?.markdown?.tables,
    });

    await this.channelManager.reconcile(specs);
  }

  /** Resolve a human-readable team label for logs/console (name preferred, falls back to ID). */
  private teamLabel(teamId: string): string {
    const team = this.teamStore?.getTeamById(teamId);
    return team?.name ?? teamId;
  }

  /** Build a human-readable session label for logs: replaces team UUID with team name. */
  private sessionLabel(sessionKey: string): string {
    const colonIdx = sessionKey.indexOf(":");
    if (colonIdx <= 0) return sessionKey;
    const teamId = sessionKey.slice(0, colonIdx);
    return this.teamLabel(teamId) + sessionKey.slice(colonIdx);
  }

  private resolveLearningModel(sessionKey: string): LanguageModel {
    const { teamId } = parseSessionKey(sessionKey);
    if (teamId && this.teamRegistry) {
      const registry = this.teamRegistry.getTeamRegistry(teamId);
      if (registry) {
        return registry.resolveOrchestrator().model;
      }
    }
    return this.model;
  }

  private buildPerSessionBrowserConfig(config: Config): ConstructorParameters<typeof BrowserManager>[0] {
    return {
      headless: config.browserHeadless,
      userAgent: config.browserUserAgent || undefined,
      // Per-session managers are already isolated by process/context ownership.
      mode: "shared",
      modeOptions: config.browserModeOptions,
      profileDir: "temp",
    };
  }

  private getRunBrowserManager(sessionKey: string): BrowserManager | null {
    if (!this.browserManager) return null;
    if (this.config.browserMode !== "per-browser-per-session") return this.browserManager;

    const existing = this.sessionBrowserManagers.get(sessionKey);
    if (existing) return existing;

    const manager = new BrowserManager(this.buildPerSessionBrowserConfig(this.config));
    this.sessionBrowserManagers.set(sessionKey, manager);
    logger.info(`[${this.sessionLabel(sessionKey)}] Created per-session browser manager`);
    return manager;
  }

  private async closeAllSessionBrowsers(): Promise<void> {
    if (this.sessionBrowserManagers.size === 0) return;
    const managers = [...this.sessionBrowserManagers.values()];
    this.sessionBrowserManagers.clear();
    await Promise.allSettled(managers.map((manager) => manager.close()));
  }

  /** Enrich session index entry with team/agent name metadata for UI display. */
  private enrichSessionMetadata(sessionKey: string, teamId: string): void {
    const meta: Parameters<SessionStore["updateMetadata"]>[1] = { teamId };

    if (this.teamStore) {
      const team = this.teamStore.getTeamById(teamId);
      if (team) meta.teamName = team.name;

      const parsed = parseSessionKey(sessionKey);
      meta.channelType = parsed.channelType;
      if (parsed.isWorker && parsed.agentName) {
        meta.agentName = parsed.agentName;
        const agent = this.teamStore.getAgentByName(teamId, parsed.agentName);
        if (agent) meta.agentId = agent.id;
      }
    }

    this.sessionStore.updateMetadata(sessionKey, meta);
  }

  private async main(sessionKey: string, text: string, images?: string[], abortSignal?: AbortSignal): Promise<string> {
    await this.reloadConfig();

    // Rebuild team registry when teams were modified or a new session started
    if (this.teamRegistryDirty || this.newSessionPending) {
      this.teamRegistryDirty = false;
      this.newSessionPending = false;
      this.rebuildTeamRegistry();
      if (this.teamRegistry) {
        if (!this.delegationStore) {
          this.delegationStore = await DelegationStore.create(MEMORY_DB_PATH);
        }
        if (!this.channelStore) {
          this.channelStore = await ChannelStore.create(MEMORY_DB_PATH);
        }
      }
    }

    // Session is guaranteed to exist (created eagerly in handleMessage/handleGatewayMessage)
    const state = this.sessions.get(sessionKey);
    if (!state) {
      logger.warn(`[${this.sessionLabel(sessionKey)}] Session was cleared mid-queue, skipping`);
      return "";
    }
    const { session } = state;

    // Resolve per-session agent (orchestrator/worker) via team registry
    const effectiveAgentId = state.agentId;
    const effectiveTeamId = state.teamId;
    if (!effectiveTeamId) {
      throw new Error("Session missing teamId");
    }
    let effectiveAgentRole: RunAgentRole | undefined;
    let runModel = this.model;
    let runModelDef = this.modelDef;
    let runIdentity = this.identity;
    let runBaseTools: ToolSet = this.tools;
    let runToolAllowlist: string[] | undefined;
    let runModelId = this.modelId;
    let runProvider = this.config.model.provider;
    let runCodexReasoningEffort = this.config.model.codexReasoningEffort;
    let runMaxSteps = 0; // 0 = inherit global default
    let teamScopedRegistry: AgentRegistry | null = null;

    if (this.teamRegistry) {
      // Resolve by team ID (source of truth from session key), not orchestrator ID
      const registry = this.teamRegistry.getTeamRegistry(effectiveTeamId);
      if (registry) {
        teamScopedRegistry = registry;
        const resolvedById = effectiveAgentId
          ? registry.resolveAgentById(effectiveAgentId)
          : { role: "orchestrator" as const, resolved: registry.resolveOrchestrator() };
        const selected = resolvedById ?? { role: "orchestrator" as const, resolved: registry.resolveOrchestrator() };
        if (effectiveAgentId && !resolvedById) {
          logger.warn(
            `[${this.sessionLabel(sessionKey)}] Bound agent "${effectiveAgentId}" not found in team "${this.teamLabel(effectiveTeamId)}" — falling back to orchestrator`,
          );
        }

        effectiveAgentRole = selected.role;
        const resolved = selected.resolved;
        runModel = resolved.model;
        runModelDef = resolved.modelDef;
        runIdentity = resolved.agentConfig.identity;
        runBaseTools = resolved.tools;
        runToolAllowlist = resolved.agentConfig.tools;
        const parsed = parseModel(resolved.agentConfig.model);
        runModelId = parsed.modelId;
        runProvider = parsed.provider;
        runCodexReasoningEffort = parsed.codexReasoningEffort;
        runMaxSteps = resolved.agentConfig.maxSteps;
        logger.info(
          `[${this.sessionLabel(sessionKey)}] Using team "${this.teamLabel(effectiveTeamId)}" ${selected.role} "${resolved.agentConfig.id}"`,
        );
      }
    }

    if (!runProvider.trim() || !runModelId.trim()) {
      logger.warn(`[${this.sessionLabel(sessionKey)}] ${MODEL_NOT_CONFIGURED_REPLY}`);
      return MODEL_NOT_CONFIGURED_REPLY;
    }

    const { normalizedText, imageDataUrls: inlineAttachmentImages } =
      await resolveInlineAttachmentContent(text);
    const allImageDataUrls = mergeImageDataUrls(images, inlineAttachmentImages);

    // Track delegation depth via worker coordinator
    this.workerCoordinator.trackDelegationDepth(sessionKey, normalizedText);

    // Detect scheduler session from key pattern
    const isSchedulerSession = sessionKey.endsWith(SCHEDULER_SESSION_SUFFIX);
    const isScheduledTask = normalizedText.startsWith(SCHEDULED_TASK_PREFIX);

    // For scheduled tasks: compact previous runs before appending
    if (isSchedulerSession && isScheduledTask) {
      compactSchedulerRuns(session);
    }

    const content = buildUserMessageContent(normalizedText, allImageDataUrls);
    session.append({ role: "user", content });
    state.estimatedMsgTokens += estimateStringTokens(normalizedText);
    // Persist the user turn immediately so history survives page switches
    // even while the assistant run is still in progress.
    await this.sessionStore.save(session);

    // Re-discover integrations at the start of each new session.
    if (!state.integrations) {
      await this.integrationRegistry.refresh(this.configStore, INTEGRATIONS_DIR, this.config);
      state.integrations = new Set();
    }

    // For scheduled tasks, merge in the scheduled integrations then consume them
    let activeIntegrations = state.integrations;
    if (isScheduledTask && state.scheduledIntegrations) {
      const merged = new Set(activeIntegrations);
      for (const name of state.scheduledIntegrations) {
        if (this.integrationRegistry.has(name)) merged.add(name);
      }
      activeIntegrations = merged;
      state.scheduledIntegrations = undefined;
    }

    // Team context for prompts (workspace + user variables).
    const teamContext =
      effectiveTeamId !== DEFAULT_TEAM_ID
        ? (this.teamRegistry?.getTeamConfig(effectiveTeamId)
          ?? this.teamStore?.toTeamConfigs().find((t) => t.id === effectiveTeamId))
        : undefined;

    // Build system prompt first so compaction can account for its token cost
    const system = buildSystemPrompt({
      identity: runIdentity,
      modelId: runModelId,
      teamWorkspace: teamContext?.workspace,
      teamVariables: teamContext?.variables,
      language: this.language,
      hasMemory: this.memoryStore !== null,
      bashMode: this.config.bash.security,
      bashSafeBins: [...DEFAULT_SAFE_BINS, ...this.config.bash.safeBins],
      hasDesktop: this.config.desktop.enabled,
      skillListing: this.skillManager.systemPrompt,
      integrationListing: this.integrationRegistry.buildListing(activeIntegrations),
      activeIntegrationPrompts: this.integrationRegistry.getPromptsFor(activeIntegrations),
      hasScheduler: this.scheduleStore !== null,
      scheduledTask: isScheduledTask,
      schedulerSession: isSchedulerSession,
      hasTTS: this.config.tts.enabled,
      channelType: state.channelType,
      hasDelegation:
        effectiveAgentRole === "orchestrator" &&
        !!teamScopedRegistry &&
        teamScopedRegistry.delegatableWorkers().length > 0,
    });

    // Skip compaction when clearly under budget (avoids O(n) token scan on every message)
    const sysTokens = estimateStringTokens(system);
    if (state.estimatedMsgTokens + sysTokens > runModelDef.contextWindow * COMPACTION_SKIP_THRESHOLD) {
      const compacted = await session.compact(runModel, runModelDef.contextWindow, system);
      if (compacted) state.estimatedMsgTokens = estimateTokens(session.getMessages());
    }

    // Snapshot active integrations before the run to detect mid-run changes
    const activeBefore = new Set(activeIntegrations);

    // Build per-run tools, adapt for MCP providers, and execute the loop
    // Task tools: default team sees all tasks; non-default teams are scoped to their own tasks
    // Schedule tools: always pass effectiveTeamId so schedules work for all teams
    const runOpts = {
      session,
      sessionKey,
      system,
      abortSignal,
      teamScopedRegistry,
      activeIntegrations,
      channelInfo: { channelType: state.channelType ?? "unknown", channelId: state.channelId ?? sessionKey },
      effectiveAgentId,
      effectiveAgentRole,
      taskTeamId: effectiveTeamId !== DEFAULT_TEAM_ID ? effectiveTeamId : undefined,
      scheduleTeamId: effectiveTeamId,
      workspaceCwd: teamContext?.workspace,
      runBaseTools,
      runToolAllowlist,
      runProvider,
      runModelId,
      runCodexReasoningEffort,
      runModel,
      contextWindow: runModelDef.contextWindow,
      maxSteps: runMaxSteps,
    };

    let runResult = await this.buildAdaptAndRun(runOpts);

    // If integrations were enabled/disabled during the run, re-run with updated tools
    if (!abortSignal?.aborted && !setsEqual(activeIntegrations, activeBefore)) {
      logger.info(`[${this.sessionLabel(sessionKey)}] Integrations changed mid-run, re-running with updated tools`);
      runResult = await this.buildAdaptAndRun(runOpts);
    }

    const reply = runResult.text;
    if (runResult.assistantContent !== null || reply.length > 0) {
      session.append({ role: "assistant", content: runResult.assistantContent ?? reply });
    }

    // Refresh running token estimate (used by compaction skip check on next message)
    const msgTokens = estimateTokens(session.getMessages());
    state.estimatedMsgTokens = msgTokens;
    logger.info(
      `[${this.sessionLabel(sessionKey)}] Context: ~${msgTokens + sysTokens} tokens (system: ${sysTokens}, messages: ${msgTokens}, budget: ${runModelDef.contextWindow})`,
    );

    await this.sessionStore.save(session);

    // Enrich session metadata with team/agent names for UI display
    this.enrichSessionMetadata(sessionKey, effectiveTeamId);

    // Track and maybe extract facts via memory extractor
    if (this.memoryExtractor) {
      const memoryTeamId = effectiveTeamId !== DEFAULT_TEAM_ID ? effectiveTeamId : undefined;
      this.memoryExtractor.trackAndMaybeExtract(sessionKey, this.sessions, session.getMessages(), memoryTeamId);
    }

    return reply;
  }
}
