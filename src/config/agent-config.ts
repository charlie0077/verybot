export interface AgentConfig {
  /** Unique agent identifier, e.g. "lead", "researcher", "coder". */
  id: string;
  /** Human-readable display name for this agent. */
  name: string;
  /** Full model string, e.g. "anthropic:claude-sonnet-4-5-20250929". */
  model: string;
  /** Override context window for custom models (0 = auto from catalog). */
  contextWindow: number;
  /** Max tool-call steps per run (0 = inherit global default). */
  maxSteps: number;
  /** System prompt / identity for this agent. */
  identity: string;
  /** Tool names to allow (empty = inherit all base tools). */
  tools: string[];
  /** Worker timeout in seconds (default 300 = 5 min). Only meaningful for workers. */
  timeout: number;
  /** If set, identity is resolved from the linked prompt template. */
  templateId?: string | null;
  /** Task statuses this agent subscribes to for pull-based execution. */
  subscriptions: string[];
  /** Max concurrent tasks this agent can run simultaneously (default 1). */
  concurrency: number;
}

export interface TaskStatusConfig {
  /** Immutable slug, e.g. "in_review". */
  key: string;
  /** Display name, e.g. "In Review". */
  label: string;
  /** Hex color, e.g. "#3b82f6". */
  color: string;
}

export interface TeamConfig {
  /** Unique team identifier, e.g. "research", "coding". */
  id: string;
  /** Human-readable label for UI. */
  name?: string;
  /** Team color for visual identification in the UI. */
  color?: string;
  /** Working directory for this team's agents. */
  workspace?: string;
  /** User-defined key-value pairs injected into agent prompts via {{varName}}. */
  variables?: Record<string, string>;
  /** Custom task statuses for this team (null/undefined = defaults). */
  statuses?: TaskStatusConfig[];
  /** The team's orchestrator agent. */
  orchestrator: AgentConfig;
  /** Workers scoped to this team. */
  workers: AgentConfig[];
}

export const DEFAULT_TEAM_ID = "default";

/** Default worker timeout: 30 minutes. */
export const DEFAULT_WORKER_TIMEOUT_S = 1_800;

/** Fallback orchestrator for teams that have no orchestrator agent row yet. */
export const FALLBACK_ORCHESTRATOR: AgentConfig = {
  id: "main",
  name: "main",
  model: "",
  contextWindow: 0,
  maxSteps: 0,
  identity: "",
  tools: [],
  timeout: DEFAULT_WORKER_TIMEOUT_S,
  subscriptions: [],
  concurrency: 1,
};
