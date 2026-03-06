import { tool } from "ai";
import { z } from "zod";
import { type TaskStore, resolveConsensusBarrier } from "../tasks/store.js";
import type { TeamStore } from "../teams/store.js";
import {
  TASK_PRIORITIES,
  MAX_TASK_COMMENT_LENGTH,
  resolveStatuses,
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
  /** TeamStore reference needed for consensus barrier checks. */
  teamStore?: TeamStore;
  /** Current agent's name (for vote comments). */
  agentName?: string;
}

/** Shared vote comment + barrier resolution logic used by both task_update and task_vote. */
function recordVoteAndCheckBarrier(
  taskStore: TaskStore,
  taskId: string,
  agentId: string,
  agentDisplayName: string,
  existingStatus: string,
  votedStatus: string,
  configuredStatuses: TaskStatusConfig[],
  teamStore: TeamStore | undefined,
  teamId: string,
  result?: string,
): { transition: string | null; noTeamStore: boolean } {
  const currentStatusConfig = configuredStatuses.find((s) => s.key === existingStatus);
  const rawConsensus = currentStatusConfig?.consensus;
  const consensus = rawConsensus === "unanimous" ? "unanimous" : "none";

  if (consensus !== "none") {
    const voteComment = result
      ? `[Vote] ${agentDisplayName} → ${votedStatus}: ${result}`
      : `[Vote] ${agentDisplayName} → ${votedStatus}`;
    taskStore.addComment(taskId, voteComment, { actor: agentId });
  }

  if (!teamStore) {
    return { transition: null, noTeamStore: true };
  }

  const subscribers = teamStore.getSubscribersForStatus(teamId, existingStatus);
  const transition = resolveConsensusBarrier(
    taskStore, taskId, existingStatus,
    subscribers, consensus, currentStatusConfig?.disagreementTransition,
  );
  return { transition, noTeamStore: false };
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
  const configuredStatuses = resolveStatuses(statuses);
  const createStatusKeys = configuredStatuses.map((s) => s.key);
  const listAndUpdateStatusKeys = [...createStatusKeys, "archived"];
  const defaultCreateStatus = createStatusKeys.includes(DEFAULT_CREATE_STATUS_KEY)
    ? DEFAULT_CREATE_STATUS_KEY
    : configuredStatuses[0]!.key;

  const createStatusDesc = configuredStatuses
    .map((s) => s.label !== s.key ? `${s.key} ("${s.label}")` : s.key)
    .join(", ");
  const statusDesc = [
    ...configuredStatuses.map((s) => s.label !== s.key ? `${s.key} ("${s.label}")` : s.key),
    "archived",
  ].join(", ");
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

      // Subscription workers: route status changes through unified vote+barrier flow
      if (statusChanged && requiredClaimOwner) {
        // Validate claim BEFORE applying any updates
        const voted = taskStore.completeClaim(id, requiredClaimOwner, existing.status, status!);
        if (!voted) {
          return `Status change failed: no active claim for this agent on task ${id} in status "${existing.status}"`;
        }

        // Apply non-status updates (if any) — only after claim is validated.
        // skipClaimCleanup: true prevents deleting the vote we just recorded.
        const hasNonStatusUpdates = [title, description, assignee, priority, needsHumanReview].some((v) => v !== undefined);
        if (hasNonStatusUpdates) {
          taskStore.update(id, { title, description, assignee, priority, needsHumanReview }, { updatedBy: actor, skipClaimCleanup: true });
          // If content changed, invalidate other agents' completed votes so consensus
          // restarts with the updated content. The current agent's vote is preserved.
          if (title !== undefined || description !== undefined) {
            taskStore.clearCompletedClaimsExcept(id, existing.status, requiredClaimOwner);
          }
        }

        const agentDisplayName = options.agentName ?? requiredClaimOwner;
        const { transition, noTeamStore } = recordVoteAndCheckBarrier(
          taskStore, id, requiredClaimOwner, agentDisplayName,
          existing.status, status!, configuredStatuses,
          options.teamStore, existing.teamId,
        );

        if (noTeamStore) {
          // No team store — fall back to direct status update (only status; non-status fields already applied above)
          const task = taskStore.update(id, { status },
            { clearClaimOnStatusChange: options.clearClaimOnStatusChange, updatedBy: actor, skipClaimCleanup: true });
          if (task) emit("taskChange", { action: "updated", task });
          if (!task) return `Task not found: ${id}`;
          return `Task updated: [${task.id}] ${task.title} — ${task.status}`;
        }
        if (transition) {
          return `Task transitioned to "${transition}" via consensus.`;
        }
        return `Vote recorded: ${status}. Waiting for consensus resolution.`;
      }

      // Non-subscription callers: direct update
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

  const voteTask = tool({
    description:
      "Vote on the next status for a task you have claimed. For unanimous consensus statuses, all agents must vote before the task transitions.",
    inputSchema: z.object({
      id: z.string().describe("Task ID to vote on"),
      status: createStatusEnum.describe("Voted next status for this task"),
      result: z.string().optional().describe("Rationale or findings for this vote"),
    }),
    execute: async ({ id, status: votedStatus, result }) => {
      const existing = taskStore.getById(id);
      if (!existing || (scoped && existing.teamId !== teamId)) return `Task not found: ${id}`;
      if (votedStatus === existing.status) {
        return `Vote rejected: cannot vote for the current status "${existing.status}"`;
      }

      // Record the vote
      const agentId = options.updatedBy ?? actor;
      const agentDisplayName = options.agentName ?? agentId;
      const voted = taskStore.completeClaim(id, agentId, existing.status, votedStatus, result);
      if (!voted) {
        return `Vote failed: no active claim found for agent "${agentId}" on task ${id} in status "${existing.status}"`;
      }

      const { transition, noTeamStore } = recordVoteAndCheckBarrier(
        taskStore, id, agentId, agentDisplayName,
        existing.status, votedStatus, configuredStatuses,
        options.teamStore, existing.teamId, result,
      );

      if (noTeamStore) {
        return `Vote recorded: ${votedStatus}. No team store available for barrier resolution.`;
      }
      if (transition) {
        return `Vote recorded. Consensus reached — task transitioned to "${transition}".`;
      }
      return `Vote recorded: ${votedStatus}. Waiting for other agents to vote.`;
    },
  });

  return {
    task_create: createTask,
    task_update: updateTask,
    task_vote: voteTask,
    task_list: listTasks,
    task_get: getTask,
    task_delete: deleteTask,
    task_comment_list: listTaskComments,
    task_comment_add: addTaskComment,
    task_comment_update: updateTaskComment,
    task_comment_delete: deleteTaskComment,
  };
}
