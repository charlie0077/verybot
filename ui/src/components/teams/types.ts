import type { TaskStatusConfig } from "../tasks/types"
import { createClientId } from "../../lib/utils"

/* ------------------------------------------------------------------ */
/*  Shared types, constants, and helpers for the Teams pages            */
/* ------------------------------------------------------------------ */

export interface AgentConfig {
  id: string
  name: string
  model: string
  contextWindow: number
  maxSteps: number
  identity: string
  tools: string[]
  timeout: number
  /** If set, identity is resolved from the linked prompt template. */
  templateId?: string | null
  /** Task statuses this agent subscribes to for pull-based execution. */
  subscriptions: string[]
  /** Max concurrent tasks this agent can run simultaneously. */
  concurrency: number
  /** Transient UI-only key for stable React list rendering. */
  _key?: string
}

export interface PromptTemplate {
  id: string
  name: string
  description: string
  role: "orchestrator" | "worker"
  content: string
  builtin: boolean
  createdAt: number
  updatedAt: number
}

export interface TeamConfig {
  id: string
  name: string
  color: string
  workspace: string
  variables: Record<string, string>
  orchestrator: AgentConfig
  workers: AgentConfig[]
  statuses?: TaskStatusConfig[]
}

export interface TeamMemory {
  id: string
  fact: string
  source: string
  timestamp: number
}

export interface GlobalModelConfig {
  model: string
  contextWindow: number
  maxSteps: number
}

export type SaveState = "idle" | "saving" | "saved" | "error"

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

export const TEAM_COLORS = [
  "#ef4444", // red
  "#f43f5e", // rose
  "#b91c1c", // red-700
  "#be123c", // rose-700
  "#f97316", // orange
  "#f59e0b", // amber
  "#c2410c", // orange-700
  "#ca8a04", // yellow-600
  "#eab308", // yellow
  "#84cc16", // lime
  "#65a30d", // lime-600
  "#22c55e", // green
  "#10b981", // emerald
  "#059669", // emerald-600
  "#14b8a6", // teal
  "#06b6d4", // cyan
  "#0284c7", // sky-600
  "#0ea5e9", // sky
  "#3b82f6", // blue
  "#2563eb", // blue-600
  "#6366f1", // indigo
  "#7c3aed", // violet-600
  "#8b5cf6", // violet
  "#a855f7", // purple
  "#d946ef", // fuchsia
  "#ec4899", // pink
  "#db2777", // pink-600
  "#64748b", // slate
  "#71717a", // zinc
  "#4d7c0f", // lime-700
  "#0f766e", // teal-700
  "#c026d3", // fuchsia-600
] as const

export const SAVE_FEEDBACK_DURATION_MS = 2_000
export const DEFAULT_WORKER_TIMEOUT_S = 1_800
export const DEFAULT_TEAM_ID = "default"
export const DEFAULT_MAX_STEPS = 20
export const DEFAULT_ORCHESTRATOR_NAME = "Orchestrator"

export const EMPTY_AGENT: AgentConfig = {
  id: "",
  name: "",
  model: "anthropic:claude-sonnet-4-5-20250929",
  contextWindow: 0,
  maxSteps: 0,
  identity: "",
  tools: [],
  timeout: DEFAULT_WORKER_TIMEOUT_S,
  subscriptions: [],
  concurrency: 1,
}

export const EMPTY_TEAM: TeamConfig = {
  id: "",
  name: "",
  color: "",
  workspace: "",
  variables: {},
  orchestrator: { ...EMPTY_AGENT },
  workers: [],
}

export const DEFAULT_GLOBAL_MODEL_CONFIG: GlobalModelConfig = {
  model: EMPTY_AGENT.model,
  contextWindow: EMPTY_AGENT.contextWindow,
  maxSteps: DEFAULT_MAX_STEPS,
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Return the first color from TEAM_COLORS not already used by existing teams. */
export function nextAvailableColor(existingTeams: TeamConfig[]): string {
  const used = new Set(existingTeams.map((t) => t.color))
  return TEAM_COLORS.find((c) => !used.has(c)) ?? TEAM_COLORS[0]
}

function readNumber(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

/** Extract global model defaults from config.get response payload. */
export function extractGlobalModelConfig(config: unknown): GlobalModelConfig {
  if (typeof config !== "object" || config === null) return DEFAULT_GLOBAL_MODEL_CONFIG
  const raw = config as Record<string, unknown>
  const model =
    typeof raw.model === "string" && raw.model.trim().length > 0
      ? raw.model
      : DEFAULT_GLOBAL_MODEL_CONFIG.model
  return {
    model,
    contextWindow: Math.max(0, readNumber(raw.contextWindow, DEFAULT_GLOBAL_MODEL_CONFIG.contextWindow)),
    maxSteps: Math.max(0, readNumber(raw.maxSteps, DEFAULT_GLOBAL_MODEL_CONFIG.maxSteps)),
  }
}

/** Filter out the auto-generated default team (no workers, id=default). */
export function isUserTeam(t: TeamConfig): boolean {
  return t.id !== DEFAULT_TEAM_ID
}

/** Strip transient UI-only `_key` fields before persisting to config. */
function stripKeys(agent: AgentConfig): AgentConfig {
  const { _key, ...rest } = agent
  void _key
  return rest as AgentConfig
}

export function cleanTeamsForPersist(teams: TeamConfig[]): TeamConfig[] {
  return teams.map(cleanTeamForPersist)
}

export function cleanTeamForPersist(t: TeamConfig): TeamConfig {
  return {
    ...t,
    name: t.name.trim(),
    workspace: t.workspace ?? "",
    variables: t.variables ?? {},
    orchestrator: stripKeys({ ...t.orchestrator, name: t.orchestrator.name.trim() }),
    workers: t.workers.map((w) => stripKeys({ ...w, name: w.name.trim() })),
    statuses: t.statuses,
  }
}

/** Build a draft TeamConfig for the detail page editor. */
export function buildInitialDraft(
  team: TeamConfig | null | undefined,
  allTeams?: TeamConfig[],
  globalModelConfig: GlobalModelConfig = DEFAULT_GLOBAL_MODEL_CONFIG,
): TeamConfig {
  if (team) {
    const isLegacyFallbackOrchestrator = team.orchestrator.model.trim().length === 0
    const orchestrator = {
      ...team.orchestrator,
      ...(isLegacyFallbackOrchestrator
        ? { id: `${team.id}:orchestrator`, model: EMPTY_AGENT.model }
        : {}),
    }

    return {
      ...team,
      orchestrator,
      workers: team.workers.map((w) => ({ ...w, _key: w._key ?? createClientId() })),
    }
  }
  return {
    ...EMPTY_TEAM,
    id: createClientId(),
    color: nextAvailableColor(allTeams ?? []),
    orchestrator: {
      ...EMPTY_AGENT,
      id: createClientId(),
      name: DEFAULT_ORCHESTRATOR_NAME,
      model: globalModelConfig.model,
      contextWindow: globalModelConfig.contextWindow,
      maxSteps: globalModelConfig.maxSteps,
    },
    workers: [],
  }
}

/** Runtime guard for the config RPC response shape. */
export function parseTeamsFromConfig(result: unknown): TeamConfig[] | null {
  if (typeof result !== "object" || result === null || !("config" in result)) return null
  const config = (result as Record<string, unknown>).config
  if (typeof config !== "object" || config === null) return null
  const raw = (config as Record<string, unknown>).teams
  return Array.isArray(raw) ? (raw as TeamConfig[]) : null
}
