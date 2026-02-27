import { handleCli, parseRuntimeCliOptions } from "./cli/index.js";
import { loadConfig, seedConfigStore, injectSecretsIntoEnv } from "./config.js";
import { ConfigStore } from "./config/store.js";
import {
  BASE_DIR,
  SESSIONS_DIR,
  MEMORY_DB_PATH,
  COMMAND_ALIASES_PATH,
  SKILLS_DIR,
  INTEGRATIONS_DIR,
  ensureDirs,
} from "./paths.js";
import { DEFAULT_GATEWAY_HOST, startGateway } from "./gateway/server.js";
import { ChannelManager } from "./channels/manager.js";
import { Agent } from "./brain/agent.js";
import { ChannelStore } from "./brain/channel-store.js";
import { DelegationStore } from "./brain/delegation-store.js";
import { ToolRegistry } from "./tools/registry.js";
import { webFetchTool } from "./tools/web-fetch.js";
import { createFsTools } from "./tools/fs.js";
import { DockerSandbox } from "./security/docker-sandbox.js";
import { BrowserManager } from "./computer/browser/manager.js";
import { createBrowserTools } from "./computer/browser/tools.js";
import { createDesktopAdapter } from "./computer/desktop/adapter.js";
import { MemoryStore } from "./memory/store.js";
import { createEmbeddingProvider } from "./memory/embedding.js";
import { loadSkills } from "./skills/loader.js";
import { loadIntegrations } from "./integrations/registry.js";
import { ScheduleStore } from "./scheduler/store.js";
import { Scheduler } from "./scheduler/scheduler.js";
import { ConnectedChannelRegistry } from "./scheduler/connected-channels.js";
import { TaskStore } from "./tasks/store.js";
import { TeamStore } from "./teams/store.js";
import { PromptTemplateStore } from "./prompt-templates/store.js";
import { BUILTIN_TEMPLATES } from "./prompt-templates/builtins/index.js";
import { CommandAliasStore } from "./aliases/store.js";
import { logger } from "./logger.js";

// --- CLI subcommand routing (no gateway boot) ---
const cliResult = handleCli();
if (cliResult) {
  cliResult.then(() => process.exit(process.exitCode ?? 0));
  // Stop here — don't boot the gateway for CLI subcommands.
} else {
let runtimeCliOptions: ReturnType<typeof parseRuntimeCliOptions>;
try {
  runtimeCliOptions = parseRuntimeCliOptions();
} catch (err) {
  logger.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

// Prevent unhandled errors from crashing the process
process.on("uncaughtException", (err) => {
  logger.error(`Uncaught exception: ${err instanceof Error ? err.stack ?? err.message : err}`);
});
process.on("unhandledRejection", (err) => {
  logger.error(`Unhandled rejection: ${err instanceof Error ? err.stack ?? err.message : err}`);
});

/* ------------------------------------------------------------------ */
/*  Runtime: all components that get torn down + rebuilt on restart     */
/* ------------------------------------------------------------------ */

interface Runtime {
  agent: Agent;
  scheduler: Scheduler;
  channels: ChannelManager;
  connectedChannels: ConnectedChannelRegistry;
  browser: BrowserManager;
  skillManager: Awaited<ReturnType<typeof loadSkills>>;
  integrationRegistry: Awaited<ReturnType<typeof loadIntegrations>>;
  memoryStore: MemoryStore | null;
  embeddingProvider: Awaited<ReturnType<typeof createEmbeddingProvider>>;
  scheduleStore: ScheduleStore;
  delegationStore: DelegationStore | null;
  channelStore: ChannelStore | null;
  taskStore: TaskStore;
  promptTemplateStore: PromptTemplateStore;
  teamStore: TeamStore;
  commandAliasStore: CommandAliasStore;
  sandbox: DockerSandbox | null;
}

async function teardown(rt: Runtime): Promise<void> {
  rt.scheduler.stop();
  await rt.agent.flushMemories();
  rt.agent.cleanupSandbox();
  rt.skillManager.stopWatching();
  await rt.integrationRegistry.cleanupAll();
  await rt.browser.close();
  rt.memoryStore?.close();
  rt.scheduleStore.close();
  rt.delegationStore?.close();
  rt.channelStore?.close();
  rt.taskStore.close();
  rt.promptTemplateStore.close();
  rt.teamStore.close();
  rt.commandAliasStore.close();
  await rt.channels.stopAll();
}

const SCHEDULER_TICK_MS = 5_000;

async function boot(configStore: ConfigStore): Promise<Runtime> {
  injectSecretsIntoEnv(configStore);
  const config = loadConfig(configStore);
  logger.info("Config loaded");

  // --- Docker Sandbox ---
  const sandbox = config.sandbox.enabled ? new DockerSandbox(config.sandbox) : null;

  // --- Tools ---
  const registry = new ToolRegistry();
  if (config.bash.security === "deny") {
    logger.info("Bash tool disabled (BASH_SECURITY=deny)");
  }
  registry.register("web_fetch", webFetchTool);

  // --- Filesystem ---
  for (const [name, t] of Object.entries(createFsTools({ sandboxed: !!sandbox }))) {
    registry.register(name, t);
  }

  // --- Browser ---
  const browser = new BrowserManager({
    headless: config.browserHeadless,
    userAgent: config.browserUserAgent || undefined,
    mode: config.browserMode,
    modeOptions: config.browserModeOptions,
  });
  for (const [name, t] of Object.entries(createBrowserTools(browser))) {
    registry.register(name, t);
  }

  // --- Desktop ---
  let desktopAdapter: Awaited<ReturnType<typeof createDesktopAdapter>> | null = null;
  try {
    desktopAdapter = await createDesktopAdapter();
    logger.info(`Desktop adapter ready (${process.platform})`);
  } catch (err) {
    logger.error(`Desktop adapter failed to initialize: ${err instanceof Error ? err.message : err}`);
  }

  // --- Skills ---
  const skillManager = await loadSkills(SKILLS_DIR);

  // --- Integrations ---
  const integrationRegistry = await loadIntegrations(config, configStore);

  // --- Memory ---
  let memoryStore: MemoryStore | null = null;
  let embeddingProvider: Awaited<ReturnType<typeof createEmbeddingProvider>> = null;

  if (config.memory.enabled) {
    memoryStore = await MemoryStore.create(MEMORY_DB_PATH);
    embeddingProvider = await createEmbeddingProvider("local");
    logger.info(`Memory enabled (embeddings: ${embeddingProvider ? embeddingProvider.id : "none"})`);
  }

  // --- Scheduler Store ---
  const scheduleStore = await ScheduleStore.create(MEMORY_DB_PATH);

  // --- Task store ---
  const taskStore = await TaskStore.create(MEMORY_DB_PATH);

  // --- Prompt template store (must exist before TeamStore for FK) ---
  const promptTemplateStore = await PromptTemplateStore.create(MEMORY_DB_PATH);
  promptTemplateStore.seedBuiltins(BUILTIN_TEMPLATES);

  // --- Team store (SQLite-backed, managed via UI/RPC) ---
  const teamStore = await TeamStore.create(MEMORY_DB_PATH);
  teamStore.ensureTeamWhenEmpty();
  const teamConfigs = teamStore.toTeamConfigs();

  // --- Global command alias store (file-backed) ---
  const commandAliasStore = await CommandAliasStore.create(COMMAND_ALIASES_PATH);

  // --- Multi-agent stores (TeamRegistry is created lazily by reloadConfig) ---
  const hasWorkers = teamConfigs.some((t) => t.workers.length > 0);
  let delegationStore: DelegationStore | null = null;
  let channelStore: ChannelStore | null = null;
  if (hasWorkers) {
    delegationStore = await DelegationStore.create(MEMORY_DB_PATH);
    channelStore = await ChannelStore.create(MEMORY_DB_PATH);
  }

  // --- Channels (created before Agent so it can reconcile them on config reload) ---
  const channels = new ChannelManager();

  // --- Connected Channels (scheduler live connections) ---
  const connectedChannels = new ConnectedChannelRegistry();

  // --- Agent ---
  const agent = new Agent({
    config,
    configStore,
    tools: registry.getAll(),
    dataDir: SESSIONS_DIR,
    memoryStore,
    embeddingProvider,
    sandbox,
    skillManager,
    integrationRegistry,
    scheduleStore,
    desktopAdapter,
    browserManager: browser,
    delegationStore,
    channelStore,
    taskStore,
    teamStore,
    promptTemplateStore,
    channelManager: channels,
    connectedChannels,
  });

  // Initial channel setup — reuses the same reconcile path as hot-reload
  await agent.initChannels();

  // --- Scheduler ---
  const scheduler = new Scheduler(scheduleStore, agent, connectedChannels, SCHEDULER_TICK_MS);
  scheduler.start();

  logger.info("Runtime booted");
  return {
    agent,
    scheduler,
    channels,
    connectedChannels,
    browser,
    skillManager,
    integrationRegistry,
    memoryStore,
    embeddingProvider,
    scheduleStore,
    delegationStore,
    channelStore,
    taskStore,
    promptTemplateStore,
    teamStore,
    commandAliasStore,
    sandbox,
  };
}

/* ------------------------------------------------------------------ */
/*  Main: gateway is long-lived, runtime is swappable                  */
/* ------------------------------------------------------------------ */

async function main() {
  ensureDirs();
  const configStore = new ConfigStore(BASE_DIR);
  seedConfigStore(configStore);

  // Mutable runtime ref — swapped on hot restart
  let runtime = await boot(configStore);

  /** Delay after teardown before booting — lets Telegram release the getUpdates long-poll. */
  const RESTART_SETTLE_MS = 2_000;

  const restart = async () => {
    logger.info("Hot restart: tearing down...");
    await teardown(runtime);
    logger.info(`Hot restart: waiting ${RESTART_SETTLE_MS}ms for connections to settle...`);
    await new Promise((r) => setTimeout(r, RESTART_SETTLE_MS));
    logger.info("Hot restart: booting...");
    runtime = await boot(configStore);
  };

  // Gateway survives restarts — RPC methods resolve agent via getter
  const config = loadConfig(configStore);
  const gatewayPort = runtimeCliOptions.gatewayPort ?? config.gateway.port;
  const gatewayHost = runtimeCliOptions.gatewayHost ?? DEFAULT_GATEWAY_HOST;
  startGateway(gatewayPort, config.gateway.token, () => runtime.agent, {
    host: gatewayHost,
    configStore,
    restart,
    getTaskStore: () => runtime.taskStore,
    getTeamStore: () => runtime.teamStore,
    getScheduleStore: () => runtime.scheduleStore,
    getConnectedChannels: () => runtime.connectedChannels,
    getMemoryStore: () => runtime.memoryStore,
    getEmbeddingProvider: () => runtime.embeddingProvider,
    getPromptTemplateStore: () => runtime.promptTemplateStore,
    getCommandAliasStore: () => runtime.commandAliasStore,
  });

  // --- Graceful shutdown ---
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return process.exit(1);
    shuttingDown = true;
    logger.info("Shutting down...");

    const forceTimer = setTimeout(() => {
      logger.warn("Shutdown timed out, forcing exit");
      process.exit(1);
    }, 5_000);
    forceTimer.unref();

    try {
      await teardown(runtime);
    } catch (err) {
      logger.error(`Shutdown error: ${err}`);
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  logger.info("Agent running. Waiting for messages...");
}

main().catch((err) => {
  logger.error(`Fatal: ${err}`);
  process.exit(1);
});

} // end CLI else-branch
