import { tool } from "ai";
import { z } from "zod";
import type { TaskStore } from "../tasks/store.js";
import {
  TASK_PRIORITIES,
  DEFAULT_TASK_STATUSES,
  MAX_TASK_COMMENT_LENGTH,
  type Task,
  type TaskComment,
  type TaskStatusConfig,
} from "../tasks/types.js";
import { DEFAULT_TEAM_ID } from "../config/agent-config.js";
import { emit } from "../events.js";

export interface CreateTaskToolsOptions {
  /**
   * Whether status changes should clear task claim ownership immediately.
   * Default true (legacy behavior).
   */
  clearClaimOnStatusChange?: boolean;
  /**
   * If set, status updates are only allowed when the task is currently
   * claimed by this agent id. Intended for strict subscription pipelines.
   */
  requireClaimedByForStatusChange?: string;
  /** Actor label used for task_create/task_update writes from this tool set. */
  updatedBy?: string;
}

function formatClaimedAt(claimedAt: number | null): string {
  return claimedAt === null ? "none" : new Date(claimedAt).toISOString();
}

function formatUpdatedAt(updatedAt: number): string {
  return new Date(updatedAt).toISOString();
}

function formatTaskListLine(task: Task): string {
  const assigned = task.assignee ? `, assigned: ${task.assignee}` : "";
  const claimedBy = task.claimedBy ?? "none";
  const claimedAt = formatClaimedAt(task.claimedAt);
  const updatedBy = task.updatedBy ?? "none";
  const updatedAt = formatUpdatedAt(task.updatedAt);
  const needsHumanReview = task.needsHumanReview ? "yes" : "no";
  return `[${task.id}] ${task.title} — ${task.status} (${task.priority}, team: ${task.teamId}${assigned}, needs_human_review: ${needsHumanReview}, claimed_by: ${claimedBy}, claimed_at: ${claimedAt}, updated_by: ${updatedBy}, updated_at: ${updatedAt})`;
}

function formatTaskCommentLine(comment: TaskComment): string {
  const createdAt = new Date(comment.createdAt).toISOString();
  if (comment.updatedAt > comment.createdAt) {
    const editedAt = new Date(comment.updatedAt).toISOString();
    return `[${comment.id}] ${comment.createdBy} @ ${createdAt} (edited by ${comment.updatedBy} @ ${editedAt}): ${comment.content}`;
  }
  return `[${comment.id}] ${comment.createdBy} @ ${createdAt}: ${comment.content}`;
}

function formatTaskAttachmentLine(attachment: Task["attachments"][number]): string {
  const createdAt = new Date(attachment.createdAt).toISOString();
  return `[${attachment.id}] ${attachment.name} (${attachment.type}, ${attachment.size} bytes, created_at: ${createdAt})`;
}

function formatTaskDetail(task: Task, comments: TaskComment[]): string {
  const assignee = task.assignee ?? "none";
  const claimedBy = task.claimedBy ?? "none";
  const claimedAt = formatClaimedAt(task.claimedAt);
  const updatedBy = task.updatedBy ?? "none";
  const updatedAt = formatUpdatedAt(task.updatedAt);
  const needsHumanReview = task.needsHumanReview ? "yes" : "no";
  const normalizedDescription = task.description?.trim()
    ? task.description
    : "(none)";
  const attachmentLines = task.attachments.length > 0
    ? task.attachments.map(formatTaskAttachmentLine)
    : ["(none)"];
  const commentLines = comments.length > 0
    ? comments.map(formatTaskCommentLine)
    : ["(none)"];

  return [
    `Task: [${task.id}] ${task.title}`,
    `Team: ${task.teamId}`,
    `Status: ${task.status}`,
    `Priority: ${task.priority}`,
    `Assignee: ${assignee}`,
    `Needs human review: ${needsHumanReview}`,
    `Claimed by: ${claimedBy}`,
    `Claimed at: ${claimedAt}`,
    `Updated by: ${updatedBy}`,
    `Updated at: ${updatedAt}`,
    "Description:",
    normalizedDescription,
    "Attachments:",
    ...attachmentLines,
    "Comments:",
    ...commentLines,
  ].join("\n");
}

/**
 * Creates AI-facing tools for task management.
 * Non-default teams are scoped to their own tasks only.
 * The default team has access to all tasks across all teams.
 *
 * @param statuses Custom task statuses for the team (undefined = defaults).
 */
export function createTaskTools(
  taskStore: TaskStore,
  teamId?: string,
  statuses?: TaskStatusConfig[],
  options: CreateTaskToolsOptions = {},
) {
  /** Non-default teams can only access their own tasks. */
  const scoped = !!teamId && teamId !== DEFAULT_TEAM_ID;
  const DEFAULT_CREATE_STATUS_KEY = "todo";

  // Build dynamic status keys from team config or fall back to global defaults.
  // Defensive fallback: some persisted teams may still have empty status lists.
  const configuredStatuses = statuses && statuses.length > 0 ? statuses : DEFAULT_TASK_STATUSES;
  const createStatusKeys = configuredStatuses.map((s) => s.key);
  const listAndUpdateStatusKeys = [...createStatusKeys, "archived"];
  const defaultCreateStatus = createStatusKeys.includes(DEFAULT_CREATE_STATUS_KEY)
    ? DEFAULT_CREATE_STATUS_KEY
    : configuredStatuses[0]?.key
    ?? DEFAULT_TASK_STATUSES[0]!.key;

  const createStatusDesc = createStatusKeys.join(", ");
  const statusDesc = listAndUpdateStatusKeys.join(", ");
  const createStatusEnum = z.enum(createStatusKeys as [string, ...string[]]);
  const statusEnum = z.enum(listAndUpdateStatusKeys as [string, ...string[]]);
  const commentContentSchema = z.string().trim().min(1).max(MAX_TASK_COMMENT_LENGTH);
  const actor = options.updatedBy ?? "assistant";

  function getScopedTask(taskId: string): Task | null {
    const task = taskStore.getById(taskId);
    if (!task) return null;
    if (scoped && task.teamId !== teamId) return null;
    return task;
  }

  const createTask = tool({
    description:
      "Create a new task for the team. Returns the created task with its ID.",
    inputSchema: z.object({
      title: z.string().describe("Short task title"),
      description: z.string().optional().describe("Optional detailed description"),
      assignee: z.string().optional().describe("Agent ID or 'user' to assign to"),
      priority: z.enum(TASK_PRIORITIES).optional().describe("Task priority: low, medium, or high"),
      status: createStatusEnum.optional().describe(`Initial status: ${createStatusDesc}`),
      needsHumanReview: z.boolean().optional().describe("Whether this task is waiting on a human review"),
    }),
    execute: async ({ title, description, assignee, priority, status, needsHumanReview }) => {
      const task = taskStore.create({
        title,
        description,
        teamId,
        assignee,
        priority,
        status: status ?? defaultCreateStatus,
        needsHumanReview,
      }, { updatedBy: actor });
      emit("taskChange", { action: "created", task });
      return `Task created: [${task.id}] ${task.title} (${task.priority}, ${task.status})`;
    },
  });

  const updateTask = tool({
    description:
      `Update an existing task. Available statuses: ${statusDesc}.`,
    inputSchema: z.object({
      id: z.string().describe("Task ID to update"),
      status: statusEnum.optional().describe(`New status: ${statusDesc}`),
      title: z.string().optional().describe("New title"),
      description: z.string().nullable().optional().describe("New description (null to clear)"),
      assignee: z.string().nullable().optional().describe("New assignee (agent ID, 'user', or null to unassign)"),
      priority: z.enum(TASK_PRIORITIES).optional().describe("New priority"),
      needsHumanReview: z.boolean().optional().describe("Set whether this task is waiting on a human review"),
    }),
    execute: async ({ id, status, title, description, assignee, priority, needsHumanReview }) => {
      const existing = taskStore.getById(id);
      if (!existing || (scoped && existing.teamId !== teamId)) return `Task not found: ${id}`;

      const statusChanged = status !== undefined && status !== existing.status;
      const requiredClaimOwner = options.requireClaimedByForStatusChange;
      if (statusChanged && requiredClaimOwner && existing.claimedBy !== requiredClaimOwner) {
        const claimOwner = existing.claimedBy ?? "none";
        return `Task status update blocked: claimed by ${claimOwner}`;
      }

      const task = taskStore.update(
        id,
        { status, title, description, assignee, priority, needsHumanReview },
        {
          clearClaimOnStatusChange: options.clearClaimOnStatusChange,
          updatedBy: actor,
        },
      );
      if (!task) return `Task not found: ${id}`;
      emit("taskChange", { action: "updated", task });
      return `Task updated: [${task.id}] ${task.title} — ${task.status} (${task.priority})`;
    },
  });

  const listTasks = tool({
    description:
      "List tasks. ALWAYS call fresh — never rely on cached results. " +
      "Only include filters the user explicitly requests. " +
      "Output includes human-review metadata (needs_human_review), claim metadata (claimed_by, claimed_at), and update metadata (updated_by, updated_at). " +
      "Returns all tasks when called with no parameters.",
    inputSchema: z.object({
      status: statusEnum.optional().describe(`Filter by status: ${statusDesc}`),
      team: z.string().optional().describe("Filter by team ID"),
      needsHumanReview: z.boolean().optional().describe("Filter tasks waiting for human review"),
    }),
    execute: async ({ status, team, needsHumanReview }) => {
      const effectiveTeamId = scoped ? teamId : team;
      const tasks = taskStore.list({ teamId: effectiveTeamId, status, needsHumanReview });
      if (tasks.length === 0) return "No tasks found.";
      return tasks.map(formatTaskListLine).join("\n");
    },
  });

  const getTask = tool({
    description:
      "Get full details for a task by ID, including description, attachments, and comments.",
    inputSchema: z.object({
      id: z.string().describe("Task ID to read"),
    }),
    execute: async ({ id }) => {
      const task = getScopedTask(id);
      if (!task) return `Task not found: ${id}`;
      const comments = taskStore.listComments(id);
      return formatTaskDetail(task, comments);
    },
  });

  const deleteTask = tool({
    description: "Permanently delete a task by ID.",
    inputSchema: z.object({
      id: z.string().describe("Task ID to delete"),
    }),
    execute: async ({ id }) => {
      if (scoped) {
        const existing = taskStore.getById(id);
        if (!existing || existing.teamId !== teamId) return `Task not found: ${id}`;
      }
      const deleted = taskStore.delete(id);
      if (!deleted) return `Task not found: ${id}`;
      emit("taskChange", { action: "deleted", id });
      return `Task deleted: ${id}`;
    },
  });

  const listTaskComments = tool({
    description: "List comments for a task by task ID.",
    inputSchema: z.object({
      taskId: z.string().describe("Task ID to read comments from"),
    }),
    execute: async ({ taskId }) => {
      const task = getScopedTask(taskId);
      if (!task) return `Task not found: ${taskId}`;
      const comments = taskStore.listComments(taskId);
      if (comments.length === 0) return `No comments found for task: ${taskId}`;
      return comments.map(formatTaskCommentLine).join("\n");
    },
  });

  const addTaskComment = tool({
    description: "Add a comment to a task.",
    inputSchema: z.object({
      taskId: z.string().describe("Task ID to comment on"),
      content: commentContentSchema.describe("Comment content"),
    }),
    execute: async ({ taskId, content }) => {
      const task = getScopedTask(taskId);
      if (!task) return `Task not found: ${taskId}`;
      const comment = taskStore.addComment(taskId, content, { actor });
      if (!comment) return `Task not found: ${taskId}`;
      emit("taskChange", { action: "commentAdded", taskId, comment });
      return `Comment added: [${comment.id}] on task ${taskId}`;
    },
  });

  const updateTaskComment = tool({
    description: "Edit an existing task comment by comment ID.",
    inputSchema: z.object({
      id: z.string().describe("Comment ID to edit"),
      content: commentContentSchema.describe("Updated comment content"),
    }),
    execute: async ({ id, content }) => {
      const existing = taskStore.getCommentById(id);
      if (!existing) return `Comment not found: ${id}`;
      const task = getScopedTask(existing.taskId);
      if (!task) return `Comment not found: ${id}`;
      const comment = taskStore.updateComment(id, content, { actor });
      if (!comment) return `Comment not found: ${id}`;
      emit("taskChange", { action: "commentUpdated", taskId: comment.taskId, comment });
      return `Comment updated: [${comment.id}]`;
    },
  });

  const deleteTaskComment = tool({
    description: "Delete a task comment by comment ID.",
    inputSchema: z.object({
      id: z.string().describe("Comment ID to delete"),
    }),
    execute: async ({ id }) => {
      const existing = taskStore.getCommentById(id);
      if (!existing) return `Comment not found: ${id}`;
      const task = getScopedTask(existing.taskId);
      if (!task) return `Comment not found: ${id}`;
      const comment = taskStore.deleteComment(id, { actor });
      if (!comment) return `Comment not found: ${id}`;
      emit("taskChange", { action: "commentDeleted", taskId: comment.taskId, id: comment.id });
      return `Comment deleted: ${id}`;
    },
  });

  return {
    task_create: createTask,
    task_update: updateTask,
    task_list: listTasks,
    task_get: getTask,
    task_delete: deleteTask,
    task_comment_list: listTaskComments,
    task_comment_add: addTaskComment,
    task_comment_update: updateTaskComment,
    task_comment_delete: deleteTaskComment,
  };
}
