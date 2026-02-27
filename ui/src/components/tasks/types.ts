import {
  ChevronUpIcon,
  EqualIcon,
  ChevronDownIcon,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"

/* ------------------------------------------------------------------ */
/*  Constants & types                                                  */
/* ------------------------------------------------------------------ */

export const DONE_VISIBLE_LIMIT = 10
export const DRAG_ACTIVATION_DISTANCE = 5
export const PRIORITIES = ["low", "medium", "high"] as const

export type Priority = (typeof PRIORITIES)[number]
export type TaskStatus = string

export interface TaskAttachment {
  id: string
  name: string
  type: string
  size: number
  createdAt: number
}

export interface TaskComment {
  id: string
  taskId: string
  content: string
  createdBy: string
  updatedBy: string
  createdAt: number
  updatedAt: number
}

export interface Task {
  id: string
  teamId: string
  title: string
  description: string | null
  status: TaskStatus
  assignee: string | null
  priority: Priority
  position: number
  attachments: TaskAttachment[]
  needsHumanReview: boolean
  claimedBy: string | null
  claimedAt: number | null
  createdAt: number
  updatedAt: number
}

export interface AgentInfo {
  id: string
  name: string
  subscriptions: string[]
  concurrency: number
}

export interface TaskStatusConfig {
  key: string
  label: string
  color: string
}

export const DEFAULT_TASK_STATUSES: TaskStatusConfig[] = [
  { key: "backlog", label: "Backlog", color: "#71717a" },
  { key: "todo", label: "Todo", color: "#64748b" },
  { key: "plan", label: "Plan", color: "#06b6d4" },
  { key: "in_progress", label: "In Progress", color: "#f59e0b" },
  { key: "done", label: "Done", color: "#22c55e" },
]

/** StatusColumnConfig is identical to TaskStatusConfig — alias for kanban column rendering. */
export type StatusColumnConfig = TaskStatusConfig

/** Build kanban column configs from a TaskStatusConfig array. */
export function buildStatusColumns(statuses: TaskStatusConfig[]): StatusColumnConfig[] {
  return statuses
}

export interface TeamConfig {
  id: string
  name?: string
  orchestrator?: AgentInfo
  workers?: AgentInfo[]
  statuses?: TaskStatusConfig[]
}

export const PRIORITY_STYLES: Record<Priority, string> = {
  high: "border-destructive/50 bg-destructive/10 text-destructive",
  medium: "border-chart-4/50 bg-chart-4/10 text-chart-4",
  low: "border-border bg-muted/50 text-muted-foreground",
}

export const PRIORITY_ICONS: Record<Priority, { icon: LucideIcon; color: string; labelKey: string }> = {
  high: { icon: ChevronUpIcon, color: "text-destructive", labelKey: "tasks.priorityHigh" },
  medium: { icon: EqualIcon, color: "text-chart-4", labelKey: "tasks.priorityMedium" },
  low: { icon: ChevronDownIcon, color: "text-muted-foreground", labelKey: "tasks.priorityLow" },
}
