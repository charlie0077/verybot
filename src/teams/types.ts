import type { TaskStatusConfig } from "../config/agent-config.js";

export interface Team {
  id: string;
  name: string;
  color: string;
  workspace: string;
  /** Custom task statuses (null/undefined = defaults). */
  statuses?: TaskStatusConfig[];
  createdAt: number;
  updatedAt: number;
}

export interface AgentRow {
  id: string;
  teamId: string;
  name: string;
  role: "orchestrator" | "worker";
  model: string;
  contextWindow: number;
  maxSteps: number;
  identity: string;
  tools: string[];
  timeout: number;
  templateId: string | null;
  /** Task statuses this agent subscribes to for pull-based execution. */
  subscriptions: string[];
  /** Max concurrent tasks this agent can run simultaneously. */
  concurrency: number;
  createdAt: number;
  updatedAt: number;
}
