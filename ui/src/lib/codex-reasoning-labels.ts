import type { CodexReasoningLevel } from "./model-spec"

export type CodexReasoningNamespace = "settings" | "teams"
type CodexReasoningKeySuffix = "Low" | "Medium" | "High" | "ExtraHigh"
type CodexReasoningDescriptionKey<N extends CodexReasoningNamespace = CodexReasoningNamespace> =
  `${N}.codexReasoning${CodexReasoningKeySuffix}`
type CodexReasoningLabelKey<N extends CodexReasoningNamespace = CodexReasoningNamespace> =
  `${CodexReasoningDescriptionKey<N>}Label`

export const CODEX_REASONING_LEVELS: readonly CodexReasoningLevel[] = [
  "low",
  "medium",
  "high",
  "extra_high",
]

const REASONING_KEY_SUFFIX_BY_LEVEL: Record<CodexReasoningLevel, CodexReasoningKeySuffix> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  extra_high: "ExtraHigh",
}

export function getCodexReasoningDescriptionKey<N extends CodexReasoningNamespace>(
  namespace: N,
  level: CodexReasoningLevel,
): CodexReasoningDescriptionKey<N> {
  return `${namespace}.codexReasoning${REASONING_KEY_SUFFIX_BY_LEVEL[level]}`
}

export function getCodexReasoningLabelKey<N extends CodexReasoningNamespace>(
  namespace: N,
  level: CodexReasoningLevel,
): CodexReasoningLabelKey<N> {
  return `${getCodexReasoningDescriptionKey(namespace, level)}Label`
}
