export type CodexReasoningEffort = "low" | "medium" | "high" | "xhigh";

export interface ParsedModelSpec {
  provider: string;
  modelId: string;
  codexReasoningEffort?: CodexReasoningEffort;
}

const CODEX_PROVIDER = "codex-cli";
const GPT_5_3_CODEX = "gpt-5.3-codex";
const DEFAULT_GPT_5_3_CODEX_REASONING: CodexReasoningEffort = "medium";
const REASONING_KEYS = ["reasoningEffort", "reasoning", "reasoningLevel", "codexReasoningEffort"] as const;

/** Parse `provider:modelId` strings with optional query params on modelId. */
export function parseModelSpec(raw: string): ParsedModelSpec {
  const [provider, ...rest] = raw.split(":");
  const modelWithQuery = rest.join(":");

  if (provider !== CODEX_PROVIDER) {
    // Preserve existing behavior for non-Codex providers: keep model id as-is.
    return { provider, modelId: modelWithQuery };
  }

  const { modelId, query } = splitModelQuery(modelWithQuery);
  const parsedEffort = parseCodexReasoningEffort(query);
  if (modelId === GPT_5_3_CODEX) {
    return {
      provider,
      modelId,
      codexReasoningEffort: parsedEffort ?? DEFAULT_GPT_5_3_CODEX_REASONING,
    };
  }

  if (parsedEffort) {
    return { provider, modelId, codexReasoningEffort: parsedEffort };
  }

  return { provider, modelId };
}

function splitModelQuery(modelWithQuery: string): { modelId: string; query: string } {
  const qIndex = modelWithQuery.indexOf("?");
  if (qIndex < 0) return { modelId: modelWithQuery, query: "" };
  return {
    modelId: modelWithQuery.slice(0, qIndex),
    query: modelWithQuery.slice(qIndex + 1),
  };
}

function parseCodexReasoningEffort(query: string): CodexReasoningEffort | undefined {
  if (!query) return undefined;
  const params = new URLSearchParams(query);
  for (const key of REASONING_KEYS) {
    const value = params.get(key);
    const normalized = normalizeCodexReasoningEffort(value);
    if (normalized) return normalized;
  }
  return undefined;
}

function normalizeCodexReasoningEffort(value: string | null): CodexReasoningEffort | undefined {
  if (!value) return undefined;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/\(current\)/g, "")
    .replace(/[-\s]/g, "_")
    .replace(/^_+|_+$/g, "");
  if (normalized === "low") return "low";
  if (normalized === "medium") return "medium";
  if (normalized === "high") return "high";
  if (normalized === "xhigh" || normalized === "extra_high" || normalized === "extrahigh") return "xhigh";
  return undefined;
}
