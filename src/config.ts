import { randomBytes } from "node:crypto";
import type { ConfigStore, ConfigData } from "./config/store.js";
import type { MarkdownTableMode } from "./markdown/ir.js";
import type { CodexReasoningEffort } from "./config/model-spec.js";
import { parseModelSpec } from "./config/model-spec.js";
import type { BrowserMode, BrowserModeOptions } from "./computer/browser/types.js";
import { logger } from "./logger.js";

export type BashSecurityMode = "deny" | "allowlist" | "full";

export interface BashConfig {
  security: BashSecurityMode;
  safeBins: string[];
  allowlist: string[];
}

interface SandboxConfig {
  enabled: boolean;
  image: string;
  memoryLimit: string;
  pidsLimit: number;
  idleTimeoutMs: number;
}

interface DesktopConfig {
  enabled: boolean;
}

export interface McpServerConfig {
  /** Command to spawn (stdio transport — inferred when present). */
  command?: string;
  /** Arguments for the command (stdio only). */
  args?: string[];
  /** Extra environment variables for the subprocess (stdio only). */
  env?: Record<string, string>;
  /** Server URL (SSE transport — inferred when present). */
  url?: string;
}

export interface Config {
  gateway: {
    port: number;
    token: string;
  };
  model: {
    provider: string;
    id: string;
    codexReasoningEffort?: CodexReasoningEffort;
    maxSteps: number;
    contextWindow: number;
  };
  browserHeadless: boolean;
  browserUserAgent: string;
  browserMode: BrowserMode;
  browserModeOptions?: BrowserModeOptions;
  language: string;
  identity: string;
  bash: BashConfig;
  sandbox: SandboxConfig;
  desktop: DesktopConfig;
  memory: {
    enabled: boolean;
    maxResults: number;
  };
  channels: {
    telegram?: { token: string; markdown?: { tables?: MarkdownTableMode } };
    discord?: { token: string; markdown?: { tables?: MarkdownTableMode } };
    slack?: { botToken: string; appToken: string; markdown?: { tables?: MarkdownTableMode } };
    whatsapp?: { phoneId: string; selfOnly?: boolean; markdown?: { tables?: MarkdownTableMode } };
  };
  mcpServers: Record<string, McpServerConfig>;
  tts: {
    enabled: boolean;
    voice: string;
    replyMode: "text" | "voice" | "inbound";
  };
}

const BROWSER_MODES: BrowserMode[] = [
  "shared",
  "per-tab-per-session",
  "per-browser-per-session",
];

const DEFAULT_MODEL_SPEC = "";
const EMPTY_VALUE_LENGTH = 0;

function parseModel(raw: string): { provider: string; id: string; codexReasoningEffort?: CodexReasoningEffort } {
  const parsed = parseModelSpec(raw);
  return {
    provider: parsed.provider,
    id: parsed.modelId,
    codexReasoningEffort: parsed.codexReasoningEffort,
  };
}

/** Check if the global model config has both provider and model ID populated. */
export function hasConfiguredModel(model: Pick<Config["model"], "provider" | "id">): boolean {
  return model.provider.trim().length > EMPTY_VALUE_LENGTH && model.id.trim().length > EMPTY_VALUE_LENGTH;
}

function parseMcpServers(raw: unknown): Record<string, McpServerConfig> {
  if (!raw) return {};
  if (typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, McpServerConfig>;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, McpServerConfig>;
      }
      return {};
    } catch {
      return {};
    }
  }
  return {};
}

/** Safely read a nested value with a fallback. */
function get<T>(val: unknown, fallback: T): T {
  return val !== undefined && val !== null ? (val as T) : fallback;
}

/**
 * Secrets in config.json that must be injected into process.env
 * so AI SDKs can find them. Key = config field, value = env var name.
 */
const ENV_SECRET_MAP: Record<string, string> = {
  ANTHROPIC_API_KEY: "ANTHROPIC_API_KEY",
  OPENAI_API_KEY: "OPENAI_API_KEY",
  GOOGLE_GENERATIVE_AI_API_KEY: "GOOGLE_GENERATIVE_AI_API_KEY",
  XAI_API_KEY: "XAI_API_KEY",
  MISTRAL_API_KEY: "MISTRAL_API_KEY",
  GROQ_API_KEY: "GROQ_API_KEY",
  TOGETHER_AI_API_KEY: "TOGETHER_AI_API_KEY",
  DEEPSEEK_API_KEY: "DEEPSEEK_API_KEY",
  OPENROUTER_API_KEY: "OPENROUTER_API_KEY",
  MINIMAX_API_KEY: "MINIMAX_API_KEY",
  ZHIPU_API_KEY: "ZHIPU_API_KEY",
  OLLAMA_BASE_URL: "OLLAMA_BASE_URL",
  CLAUDE_CODE_OAUTH_TOKEN: "CLAUDE_CODE_OAUTH_TOKEN",
};

/**
 * Inject API keys from config.json into process.env so AI SDK providers work.
 * Only sets values that are non-empty and not already set in the environment.
 */
export function injectSecretsIntoEnv(store: ConfigStore): void {
  const data = store.load();
  for (const [configKey, envKey] of Object.entries(ENV_SECRET_MAP)) {
    const val = data[configKey];
    if (typeof val === "string" && val) {
      process.env[envKey] = val;
    }
  }
}

const GATEWAY_TOKEN_BYTES = 32;

/** Generate a cryptographically random gateway token (URL-safe base64, 32 bytes). */
export function generateGatewayToken(): string {
  return randomBytes(GATEWAY_TOKEN_BYTES).toString("base64url");
}

/**
 * Create initial config.json with all configurable keys and defaults.
 * Only runs when config.json doesn't exist yet.
 */
export function seedConfigStore(store: ConfigStore): void {
  const existing = store.load();
  if (Object.keys(existing).length > 0) return;

  const seed: ConfigData = {
    // Model
    model: DEFAULT_MODEL_SPEC,
    maxSteps: 20,
    browserHeadless: true,
    browserUserAgent: "",
    browserMode: "per-tab-per-session",
    browserModeOptions: {},

    // Agent
    language: "auto",
    identity: "You are a helpful personal assistant.",

    // Gateway
    gateway: { port: 28789 },

    // Bash
    bash: { security: "full", safeBins: [], allowlist: [] },

    // Sandbox
    sandbox: {
      enabled: false,
      image: "ubuntu:24.04",
      memoryLimit: "256m",
      pidsLimit: 64,
      idleTimeoutMs: 300_000,
    },

    // Desktop
    desktop: { enabled: false },

    // Memory
    memory: { enabled: true, maxResults: 5 },

    // TTS
    tts: { enabled: true, voice: "en-US-AriaNeural", replyMode: "inbound" },

    // MCP servers
    mcpServers: {},

    // Secrets (empty — set via web UI)
    ANTHROPIC_API_KEY: "",
    OPENAI_API_KEY: "",
    GOOGLE_GENERATIVE_AI_API_KEY: "",
    XAI_API_KEY: "",
    MISTRAL_API_KEY: "",
    GROQ_API_KEY: "",
    TOGETHER_AI_API_KEY: "",
    DEEPSEEK_API_KEY: "",
    OPENROUTER_API_KEY: "",
    MINIMAX_API_KEY: "",
    ZHIPU_API_KEY: "",
    OLLAMA_BASE_URL: "",
    CLAUDE_CODE_OAUTH_TOKEN: "",
    GATEWAY_TOKEN: generateGatewayToken(),
    TELEGRAM_BOT_TOKEN: "",
    DISCORD_BOT_TOKEN: "",
    SLACK_BOT_TOKEN: "",
    SLACK_APP_TOKEN: "",
    WHATSAPP_PHONE_ID: "",
    TWITTER_BEARER_TOKEN: "",
    TWITTER_API_KEY: "",
    TWITTER_API_SECRET: "",
    TWITTER_ACCESS_TOKEN: "",
    TWITTER_ACCESS_SECRET: "",
    GITHUB_TOKEN: "",
    GITHUB_DEFAULT_OWNER: "",
  };

  store.save(seed);
}

/**
 * Load config exclusively from config.json (via ConfigStore).
 * No .env fallbacks — config.json is the sole source of truth.
 */
export function loadConfig(store: ConfigStore): Config {
  const s = store.load();

  const modelRaw = get(s.model, DEFAULT_MODEL_SPEC) as string;
  const gateway = (s.gateway ?? {}) as Record<string, unknown>;
  const bash = (s.bash ?? {}) as Record<string, unknown>;
  const sandbox = (s.sandbox ?? {}) as Record<string, unknown>;
  const memory = (s.memory ?? {}) as Record<string, unknown>;
  const tts = (s.tts ?? {}) as Record<string, unknown>;
  const legacyMcp = (s.mcp as Record<string, unknown> | undefined) ?? {};

  const identityStr = get(s.identity, "You are a helpful personal assistant.") as string;

  const telegramToken = get(s.TELEGRAM_BOT_TOKEN, "") as string;
  const discordToken = get(s.DISCORD_BOT_TOKEN, "") as string;
  const slackBotToken = get(s.SLACK_BOT_TOKEN, "") as string;
  const slackAppToken = get(s.SLACK_APP_TOKEN, "") as string;
  const whatsappPhoneId = get(s.WHATSAPP_PHONE_ID, "") as string;
  const channelsCfg = (s.channels ?? {}) as Record<string, Record<string, unknown>>;

  // Auto-generate a gateway token if missing or empty
  let gatewayToken = (s.GATEWAY_TOKEN as string) || "";
  if (!gatewayToken) {
    gatewayToken = generateGatewayToken();
    store.patch({ GATEWAY_TOKEN: gatewayToken });
    logger.info(`Generated new \x1b[36mGATEWAY_TOKEN\x1b[0m: \x1b[1m\x1b[33m${gatewayToken}\x1b[0m`);
  }
  logger.info(`\x1b[36mGATEWAY_TOKEN\x1b[0m: \x1b[1m\x1b[33m${gatewayToken}\x1b[0m`);

  // Browser mode configuration
  const browserModeRaw = get<unknown>(
    s.browserMode,
    "per-tab-per-session",
  );
  const browserMode = BROWSER_MODES.includes(browserModeRaw as BrowserMode)
    ? (browserModeRaw as BrowserMode)
    : "per-tab-per-session";
  if (browserModeRaw !== browserMode) {
    logger.warn(
      `Invalid browserMode "${String(browserModeRaw)}"; using "${browserMode}"`,
    );
  }
  const browserModeOptions = get<BrowserModeOptions | undefined>(
    s.browserModeOptions,
    undefined
  );

  return {
    gateway: {
      port: Number(get(gateway.port, 28789)),
      token: gatewayToken,
    },
    model: {
      ...parseModel(modelRaw),
      maxSteps: Number(get(s.maxSteps, 20)),
      contextWindow: Number(get(s.contextWindow, 0)),
    },
    browserHeadless: get(s.browserHeadless, true) as boolean,
    browserUserAgent: get(s.browserUserAgent, "") as string,
    browserMode,
    browserModeOptions,
    language: get(s.language, "auto") as string,
    identity: identityStr,
    bash: {
      security: get(bash.security, "full") as BashSecurityMode,
      safeBins: get(bash.safeBins, []) as string[],
      allowlist: get(bash.allowlist, []) as string[],
    },
    sandbox: {
      enabled: get(sandbox.enabled, false) as boolean,
      image: get(sandbox.image, "ubuntu:24.04") as string,
      memoryLimit: get(sandbox.memoryLimit, "256m") as string,
      pidsLimit: Number(get(sandbox.pidsLimit, 64)),
      idleTimeoutMs: Number(get(sandbox.idleTimeoutMs, 300_000)),
    },
    desktop: {
      enabled: get((s.desktop as Record<string, unknown> | undefined)?.enabled, false) as boolean,
    },
    memory: {
      enabled: get(memory.enabled, true) as boolean,
      maxResults: Number(get(memory.maxResults, 5)),
    },
    channels: {
      telegram: telegramToken
        ? {
            token: telegramToken,
            markdown: (channelsCfg.telegram?.markdown as { tables?: MarkdownTableMode } | undefined) ?? undefined,
          }
        : undefined,
      discord: discordToken
        ? {
            token: discordToken,
            markdown: (channelsCfg.discord?.markdown as { tables?: MarkdownTableMode } | undefined) ?? undefined,
          }
        : undefined,
      slack:
        slackBotToken && slackAppToken
          ? {
              botToken: slackBotToken,
              appToken: slackAppToken,
              markdown: (channelsCfg.slack?.markdown as { tables?: MarkdownTableMode } | undefined) ?? undefined,
            }
          : undefined,
      whatsapp: whatsappPhoneId
        ? {
            phoneId: whatsappPhoneId,
            selfOnly: get(channelsCfg.whatsapp?.selfOnly, false) as boolean,
            markdown: (channelsCfg.whatsapp?.markdown as { tables?: MarkdownTableMode } | undefined) ?? undefined,
          }
        : undefined,
    },
    mcpServers: parseMcpServers(s.mcpServers ?? legacyMcp.servers),
    tts: {
      enabled: get(tts.enabled, true) as boolean,
      voice: get(tts.voice, "en-US-AriaNeural") as string,
      replyMode: get(tts.replyMode, "inbound") as "text" | "voice" | "inbound",
    },
  };
}
