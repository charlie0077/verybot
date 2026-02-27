export interface ModelDef {
  /** Provider key matching `providers.ts`, e.g. "anthropic". */
  provider: string;
  /** Full model ID passed to the provider SDK, e.g. "claude-sonnet-4-5-20250929". */
  modelId: string;
  /** Human-readable group label for the UI picker. */
  group: string;
  /** Context window size in tokens. */
  contextWindow: number;
}

/**
 * Single source of truth for all built-in model definitions.
 * Both the UI picker list and the context-window metadata derive from this.
 */
export const MODEL_CATALOG: ModelDef[] = [
  // Claude Code (subscription — no API key needed, requires `claude login`)
  { provider: "claude-code", modelId: "haiku", group: "Claude Code", contextWindow: 200_000 },
  { provider: "claude-code", modelId: "sonnet", group: "Claude Code", contextWindow: 200_000 },
  { provider: "claude-code", modelId: "opus", group: "Claude Code", contextWindow: 200_000 },
  // Codex CLI (OpenAI subscription — no API key needed, requires `codex login`)
  // Context windows are approximate; override via config `contextWindow` if needed.
  { provider: "codex-cli", modelId: "gpt-5.3-codex", group: "Codex CLI", contextWindow: 200_000 },
  { provider: "codex-cli", modelId: "gpt-5.3-codex-spark", group: "Codex CLI", contextWindow: 200_000 },
  { provider: "codex-cli", modelId: "gpt-5.2", group: "Codex CLI", contextWindow: 200_000 },
  { provider: "codex-cli", modelId: "gpt-5.1-codex-mini", group: "Codex CLI", contextWindow: 200_000 },
  { provider: "codex-cli", modelId: "gpt-5.1-codex-max", group: "Codex CLI", contextWindow: 200_000 },
  { provider: "codex-cli", modelId: "gpt-5.2-codex", group: "Codex CLI", contextWindow: 200_000 },
  // Anthropic (API key)
  { provider: "anthropic", modelId: "claude-haiku-4-5-20251001", group: "Anthropic", contextWindow: 200_000 },
  { provider: "anthropic", modelId: "claude-opus-4-6", group: "Anthropic", contextWindow: 200_000 },
  { provider: "anthropic", modelId: "claude-sonnet-4-5-20250929", group: "Anthropic", contextWindow: 200_000 },
  // OpenAI
  { provider: "openai", modelId: "gpt-4.1", group: "OpenAI", contextWindow: 1_000_000 },
  { provider: "openai", modelId: "gpt-4o", group: "OpenAI", contextWindow: 128_000 },
  { provider: "openai", modelId: "gpt-4o-mini", group: "OpenAI", contextWindow: 128_000 },
  // Google
  { provider: "google", modelId: "gemini-2.0-flash", group: "Google", contextWindow: 1_000_000 },
  { provider: "google", modelId: "gemini-2.5-pro", group: "Google", contextWindow: 1_000_000 },
  // Groq
  { provider: "groq", modelId: "llama-3.1-8b-instant", group: "Groq", contextWindow: 131_072 },
  { provider: "groq", modelId: "llama-3.3-70b-versatile", group: "Groq", contextWindow: 128_000 },
  { provider: "groq", modelId: "mixtral-8x7b-32768", group: "Groq", contextWindow: 32_768 },
  // OpenRouter — own models + top 15 most popular (openrouter.ai/rankings)
  { provider: "openrouter", modelId: "anthropic/claude-4.5-opus-20251124", group: "OpenRouter", contextWindow: 200_000 },
  { provider: "openrouter", modelId: "anthropic/claude-4.5-sonnet-20250929", group: "OpenRouter", contextWindow: 1_000_000 },
  { provider: "openrouter", modelId: "anthropic/claude-4.6-opus-20260205", group: "OpenRouter", contextWindow: 1_000_000 },
  { provider: "openrouter", modelId: "deepseek/deepseek-v3.2-20251201", group: "OpenRouter", contextWindow: 163_840 },
  { provider: "openrouter", modelId: "google/gemini-2.0-flash-001", group: "OpenRouter", contextWindow: 1_048_576 },
  { provider: "openrouter", modelId: "google/gemini-2.5-flash", group: "OpenRouter", contextWindow: 1_048_576 },
  { provider: "openrouter", modelId: "google/gemini-2.5-pro", group: "OpenRouter", contextWindow: 1_048_576 },
  { provider: "openrouter", modelId: "google/gemini-3-flash-preview-20251217", group: "OpenRouter", contextWindow: 1_048_576 },
  { provider: "openrouter", modelId: "minimax/minimax-m2.1", group: "OpenRouter", contextWindow: 196_608 },
  { provider: "openrouter", modelId: "minimax/minimax-m2.5", group: "OpenRouter", contextWindow: 204_800 },
  { provider: "openrouter", modelId: "mistralai/devstral-2512", group: "OpenRouter", contextWindow: 262_144 },
  { provider: "openrouter", modelId: "moonshotai/kimi-k2.5-0127", group: "OpenRouter", contextWindow: 262_144 },
  { provider: "openrouter", modelId: "openai/gpt-5.2-20251211", group: "OpenRouter", contextWindow: 400_000 },
  { provider: "openrouter", modelId: "openai/gpt-oss-120b", group: "OpenRouter", contextWindow: 131_072 },
  { provider: "openrouter", modelId: "openrouter/aurora-alpha", group: "OpenRouter", contextWindow: 128_000 },
  { provider: "openrouter", modelId: "openrouter/pony-alpha", group: "OpenRouter", contextWindow: 200_000 },
  { provider: "openrouter", modelId: "x-ai/grok-4.1-fast", group: "OpenRouter", contextWindow: 2_000_000 },
  { provider: "openrouter", modelId: "x-ai/grok-code-fast-1", group: "OpenRouter", contextWindow: 256_000 },
  // MiniMax
  { provider: "minimax", modelId: "MiniMax-M2.5", group: "MiniMax", contextWindow: 204_800 },
  { provider: "minimax", modelId: "MiniMax-M2.5-highspeed", group: "MiniMax", contextWindow: 204_800 },
  // Zhipu
  { provider: "zhipu", modelId: "glm-5", group: "Zhipu", contextWindow: 200_000 },
  { provider: "zhipu", modelId: "glm-4.7", group: "Zhipu", contextWindow: 200_000 },
  { provider: "zhipu", modelId: "glm-4.7-flash", group: "Zhipu", contextWindow: 200_000 },
  { provider: "zhipu", modelId: "glm-4-plus", group: "Zhipu", contextWindow: 128_000 },
  { provider: "zhipu", modelId: "glm-4-flash", group: "Zhipu", contextWindow: 128_000 },
  { provider: "zhipu", modelId: "glm-4-long", group: "Zhipu", contextWindow: 1_000_000 },
  // DeepSeek
  { provider: "deepseek", modelId: "deepseek-chat", group: "DeepSeek", contextWindow: 128_000 },
  { provider: "deepseek", modelId: "deepseek-reasoner", group: "DeepSeek", contextWindow: 128_000 },
  // Mistral
  { provider: "mistral", modelId: "codestral-latest", group: "Mistral", contextWindow: 256_000 },
  { provider: "mistral", modelId: "mistral-large-latest", group: "Mistral", contextWindow: 128_000 },
  { provider: "mistral", modelId: "mistral-small-latest", group: "Mistral", contextWindow: 128_000 },
  // xAI
  { provider: "xai", modelId: "grok-3", group: "xAI", contextWindow: 131_072 },
  { provider: "xai", modelId: "grok-3-mini", group: "xAI", contextWindow: 131_072 },
  // Together AI
  { provider: "togetherai", modelId: "meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo", group: "Together AI", contextWindow: 128_000 },
  { provider: "togetherai", modelId: "meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo", group: "Together AI", contextWindow: 128_000 },
  // Ollama (local)
  { provider: "ollama", modelId: "deepseek-r1", group: "Ollama", contextWindow: 128_000 },
  { provider: "ollama", modelId: "llama3.3", group: "Ollama", contextWindow: 128_000 },
  { provider: "ollama", modelId: "qwen2.5", group: "Ollama", contextWindow: 128_000 },
];

const FALLBACK_CONTEXT_WINDOW = 128_000;

/** Lookup map keyed by modelId for exact matching. */
const catalogByModelId = new Map(
  MODEL_CATALOG.map((m) => [m.modelId, m]),
);

/**
 * Resolve a ModelDef for a given model ID.
 * Lookup order: exact match > longest-prefix match > fallback.
 * `contextWindowOverride` only applies when the model is NOT in the catalog —
 * catalog values are always authoritative.
 */
export function resolveModelDef(modelId: string, contextWindowOverride = 0): ModelDef {
  // Exact match — catalog is authoritative, ignore override
  const exact = catalogByModelId.get(modelId);
  if (exact) return exact;

  // Longest-prefix match — also authoritative
  const prefix = findPrefixMatch(modelId);
  if (prefix) return prefix;

  // Unknown model — apply user override if provided, else fallback
  const ctxWindow = contextWindowOverride > 0 ? contextWindowOverride : FALLBACK_CONTEXT_WINDOW;
  return { provider: "unknown", modelId, group: "Other", contextWindow: ctxWindow };
}

function findPrefixMatch(modelId: string): ModelDef | undefined {
  let best: ModelDef | undefined;
  let bestLen = 0;
  for (const entry of MODEL_CATALOG) {
    if (modelId.startsWith(entry.modelId) && entry.modelId.length > bestLen) {
      best = entry;
      bestLen = entry.modelId.length;
    }
  }
  return best;
}
