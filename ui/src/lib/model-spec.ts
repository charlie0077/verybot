export type CodexReasoningLevel = "low" | "medium" | "high" | "extra_high"

const CODEX_REASONING_MODEL = "codex-cli:gpt-5.3-codex"
const DEFAULT_CODEX_REASONING_LEVEL: CodexReasoningLevel = "medium"
const REASONING_KEYS = ["reasoningEffort", "reasoning", "reasoningLevel", "codexReasoningEffort"] as const
const REASONING_EFFORT_BY_LEVEL: Record<CodexReasoningLevel, string> = {
  low: "low",
  medium: "medium",
  high: "high",
  // ai-sdk-provider-codex-cli expects xhigh for the extra-high effort tier.
  extra_high: "xhigh",
}

interface SplitModelValue {
  provider: string
  modelId: string
  query: string
}

export function stripModelOptions(model: string): string {
  const parsed = splitModelValue(model)
  if (!parsed) return model
  return `${parsed.provider}:${parsed.modelId}`
}

export function supportsCodexReasoningLevel(model: string): boolean {
  return stripModelOptions(model) === CODEX_REASONING_MODEL
}

export function getCodexReasoningLevel(model: string): CodexReasoningLevel | null {
  if (!supportsCodexReasoningLevel(model)) return null
  const parsed = splitModelValue(model)
  if (!parsed) return DEFAULT_CODEX_REASONING_LEVEL
  return parseReasoningLevel(parsed.query) ?? DEFAULT_CODEX_REASONING_LEVEL
}

export function setCodexReasoningLevel(model: string, level: CodexReasoningLevel): string {
  if (!supportsCodexReasoningLevel(model)) return model
  const parsed = splitModelValue(model)
  if (!parsed) return model

  const params = new URLSearchParams(parsed.query)
  for (const key of REASONING_KEYS) params.delete(key)
  params.set("reasoningEffort", REASONING_EFFORT_BY_LEVEL[level])

  const query = params.toString()
  return query
    ? `${parsed.provider}:${parsed.modelId}?${query}`
    : `${parsed.provider}:${parsed.modelId}`
}

function splitModelValue(model: string): SplitModelValue | null {
  const colon = model.indexOf(":")
  if (colon < 0) return null
  const provider = model.slice(0, colon)
  const modelWithQuery = model.slice(colon + 1)
  const qIndex = modelWithQuery.indexOf("?")
  if (qIndex < 0) {
    return { provider, modelId: modelWithQuery, query: "" }
  }
  return {
    provider,
    modelId: modelWithQuery.slice(0, qIndex),
    query: modelWithQuery.slice(qIndex + 1),
  }
}

function parseReasoningLevel(query: string): CodexReasoningLevel | undefined {
  if (!query) return undefined
  const params = new URLSearchParams(query)
  for (const key of REASONING_KEYS) {
    const normalized = normalizeReasoning(params.get(key))
    if (normalized) return normalized
  }
  return undefined
}

function normalizeReasoning(value: string | null): CodexReasoningLevel | undefined {
  if (!value) return undefined
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/\(current\)/g, "")
    .replace(/[-\s]/g, "_")
    .replace(/^_+|_+$/g, "")
  if (normalized === "low") return "low"
  if (normalized === "medium") return "medium"
  if (normalized === "high") return "high"
  if (normalized === "xhigh" || normalized === "extra_high" || normalized === "extrahigh") return "extra_high"
  return undefined
}
