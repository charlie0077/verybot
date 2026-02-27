import { anthropic } from "@ai-sdk/anthropic";
import { createClaudeCode } from "ai-sdk-provider-claude-code";
import { createCodexCli } from "ai-sdk-provider-codex-cli";
import { openai } from "@ai-sdk/openai";
import { google } from "@ai-sdk/google";
import { xai } from "@ai-sdk/xai";
import { mistral } from "@ai-sdk/mistral";
import { groq } from "@ai-sdk/groq";
import { togetherai } from "@ai-sdk/togetherai";
import { deepseek } from "@ai-sdk/deepseek";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { minimax } from "vercel-minimax-ai-provider";
import { zhipu } from "zhipu-ai-provider";
import type { LanguageModel } from "ai";
import type { CodexReasoningEffort } from "../config/model-spec.js";

/** Provider identifier for Claude Code (used for MCP adapter detection). */
export const CLAUDE_CODE_PROVIDER = "claude-code";

/** Provider identifier for Codex CLI (used for MCP adapter detection). */
export const CODEX_CLI_PROVIDER = "codex-cli";

/** Force subscription auth by clearing API key from the SDK environment. */
export const CODEX_CLI_ENV = { OPENAI_API_KEY: "" } as const;

/**
 * Create Claude Code provider lazily. Reads CLAUDE_CODE_OAUTH_TOKEN from
 * process.env which is kept fresh by reloadConfig() → injectSecretsIntoEnv()
 * on every request.
 */
function getClaudeCode() {
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  return createClaudeCode({
    defaultSettings: {
      permissionMode: "bypassPermissions",
      env: {
        ANTHROPIC_API_KEY: undefined,
        ...(token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {}),
      },
    },
  });
}

/**
 * Base Codex CLI provider (no tools). Tools are added per-session in mcp-adapter.ts.
 * Explicitly bypass approvals and sandbox to match "bypass all permissions" behavior.
 */
const codexCliBase = createCodexCli({
  defaultSettings: {
    dangerouslyBypassApprovalsAndSandbox: true,
    env: CODEX_CLI_ENV,
  },
});

export interface GetModelOptions {
  codexReasoningEffort?: CodexReasoningEffort;
}

const providers: Record<string, (id: string, options?: GetModelOptions) => LanguageModel> = {
  anthropic: (id) => anthropic(id),
  [CLAUDE_CODE_PROVIDER]: (id) => getClaudeCode()(id, { streamingInput: "always" }),
  [CODEX_CLI_PROVIDER]: (id, options) =>
    codexCliBase(
      id,
      options?.codexReasoningEffort
        ? { reasoningEffort: options.codexReasoningEffort }
        : undefined,
    ),
  openai: (id) => openai(id),
  google: (id) => google(id),
  xai: (id) => xai(id),
  mistral: (id) => mistral(id),
  groq: (id) => groq(id),
  togetherai: (id) => togetherai(id),
  deepseek: (id) => deepseek(id),
  minimax: (id) => minimax(id),
  zhipu: (id) => zhipu(id),
  openrouter: (id) => {
    const provider = createOpenAICompatible({
      name: "openrouter",
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: process.env.OPENROUTER_API_KEY,
    });
    return provider(id);
  },
  ollama: (id) => {
    const provider = createOpenAICompatible({
      name: "ollama",
      baseURL: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1",
      apiKey: "ollama",
    });
    return provider(id);
  },
};

export function getModel(provider: string, modelId: string, options?: GetModelOptions): LanguageModel {
  const factory = providers[provider];
  if (!factory) {
    throw new Error(`Unknown provider: ${provider}. Available: ${Object.keys(providers).join(", ")}`);
  }
  return factory(modelId, options);
}
