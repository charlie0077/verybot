import { z } from "zod";

/** Max upload file size: 10 MB */
export const MAX_FILE_SIZE = 10 * 1024 * 1024;

const ALLOWED_ATTACHMENT_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export const ALLOWED_IMAGE_TYPES = new Set<string>(ALLOWED_ATTACHMENT_TYPES);

export const EXT_FOR_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

/** Legacy list of default status keys — used only for migration backfills. */
export const LEGACY_STATUS_KEYS = ["backlog", "todo", "plan", "in_progress", "done", "archived"] as const;
/** Status is now a free-form string to support per-team custom statuses. */
export type TaskStatus = string;

/** Reusable Zod string for task status keys: 1-128 chars, word-chars only. */
const StatusKeySchema = z.string().min(1).max(128).regex(/^\w+$/, "Status key must be alphanumeric/underscore");

export const TASK_PRIORITIES = ["low", "medium", "high"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

/* ------------------------------------------------------------------ */
/*  Per-team custom task statuses                                      */
/* ------------------------------------------------------------------ */

// Canonical definition lives in config/agent-config.ts — re-export here for convenience.
import type { TaskStatusConfig } from "../config/agent-config.js";
export type { TaskStatusConfig } from "../config/agent-config.js";

/** Default statuses used when a team has no custom config. */
export const DEFAULT_TASK_STATUSES: TaskStatusConfig[] = [
  { key: "backlog", label: "Backlog", color: "#71717a" },
  { key: "todo", label: "Todo", color: "#64748b" },
  { key: "plan", label: "Plan", color: "#06b6d4" },
  { key: "in_progress", label: "In Progress", color: "#f59e0b" },
  { key: "done", label: "Done", color: "#22c55e" },
];

export interface TaskAttachment {
  id: string;
  name: string;
  type: string;
  size: number;
  createdAt: number;
}

export interface TaskComment {
  id: string;
  taskId: string;
  content: string;
  createdBy: string;
  updatedBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface Task {
  id: string;
  teamId: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  assignee: string | null;
  priority: TaskPriority;
  position: number;
  attachments: TaskAttachment[];
  /** True when the task is waiting on a human to review or act. */
  needsHumanReview: boolean;
  /** Agent ID that claimed this task for pull-based execution. */
  claimedBy: string | null;
  /** Timestamp when the task was claimed. */
  claimedAt: number | null;
  /** Last actor that updated this task (user, orchestrator, worker, system). */
  updatedBy: string | null;
  createdAt: number;
  updatedAt: number;
}

const MAX_ATTACHMENTS_PER_TASK = 20;
export const MAX_TASK_COMMENT_LENGTH = 4000;

const TaskAttachmentSchema = z.object({
  id: z.string().regex(/^[0-9a-f-]+\.(png|jpg|gif|webp)$/),
  name: z.string().max(255),
  type: z.enum(ALLOWED_ATTACHMENT_TYPES),
  size: z.number().int().positive().max(10 * 1024 * 1024),
  createdAt: z.number().int().positive(),
});

const TaskCommentContentSchema = z.string().trim().min(1).max(MAX_TASK_COMMENT_LENGTH);

export const CreateTaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  teamId: z.string().optional(),
  assignee: z.string().optional(),
  priority: z.enum(TASK_PRIORITIES).default("medium"),
  status: StatusKeySchema.default("todo"),
  needsHumanReview: z.boolean().default(false),
  attachments: z.array(TaskAttachmentSchema).max(MAX_ATTACHMENTS_PER_TASK).optional(),
});

export const UpdateTaskSchema = z.object({
  id: z.string(),
  title: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  status: StatusKeySchema.optional(),
  assignee: z.string().nullable().optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  teamId: z.string().nullable().optional(),
  needsHumanReview: z.boolean().optional(),
  attachments: z.array(TaskAttachmentSchema).max(MAX_ATTACHMENTS_PER_TASK).optional(),
});

export const ListTasksSchema = z.object({
  teamId: z.string().optional(),
  status: StatusKeySchema.optional(),
  assignee: z.string().optional(),
  needsHumanReview: z.boolean().optional(),
  includeArchived: z.boolean().optional(),
});

export const ReorderTasksSchema = z.object({
  status: StatusKeySchema,
  orderedIds: z.array(z.string()).min(1),
});

export const ListTaskCommentsSchema = z.object({
  taskId: z.string().min(1),
});

export const AddTaskCommentSchema = z.object({
  taskId: z.string().min(1),
  content: TaskCommentContentSchema,
});

export const UpdateTaskCommentSchema = z.object({
  id: z.string().min(1),
  content: TaskCommentContentSchema,
});

export const DeleteTaskCommentSchema = z.object({
  id: z.string().min(1),
});
