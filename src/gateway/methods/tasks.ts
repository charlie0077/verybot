import { writeFile, readFile } from "node:fs/promises";
import { join, basename, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { emit } from "../../events.js";
import { logger } from "../../logger.js";
import { ATTACHMENTS_DIR } from "../../paths.js";
import type { TaskStore } from "../../tasks/store.js";
import type { TeamStore } from "../../teams/store.js";
import {
  CreateTaskSchema, UpdateTaskSchema, ListTasksSchema, ReorderTasksSchema,
  ListTaskCommentsSchema, AddTaskCommentSchema, UpdateTaskCommentSchema, DeleteTaskCommentSchema,
  MAX_FILE_SIZE, ALLOWED_IMAGE_TYPES, EXT_FOR_MIME,
  type TaskAttachment,
} from "../../tasks/types.js";

/** Reverse lookup: file extension -> MIME type */
const MIME_FOR_EXT = Object.fromEntries(
  Object.entries(EXT_FOR_MIME).map(([mime, ext]) => [ext, mime]),
);

/** Max base64 string length for MAX_FILE_SIZE bytes */
const MAX_BASE64_LENGTH = Math.ceil(MAX_FILE_SIZE * 4 / 3) + 4;
const STATUS_KEY_RE = /^\w+$/;

const UploadAttachmentSchema = z.object({
  name: z.string().min(1).max(255),
  type: z.string(),
  data: z.string().min(1),
});

const GetAttachmentSchema = z.object({
  id: z.string().min(1),
});

const ArchiveDoneSchema = z.object({
  teamId: z.string().optional(),
  status: z.string().regex(STATUS_KEY_RE).optional(),
});

const DEFAULT_DONE_STATUS = "done";

function resolveDoneStatus(
  status: string | undefined,
): string {
  if (status) return status;
  return DEFAULT_DONE_STATUS;
}

export function taskMethods(taskStore: TaskStore, _teamStore?: TeamStore | null) {
  return {
    "tasks.list": async (params: unknown) => {
      const filter = ListTasksSchema.parse(params ?? {});
      return { tasks: taskStore.list(filter) };
    },

    "tasks.create": async (params: unknown) => {
      const input = CreateTaskSchema.parse(params);
      const task = taskStore.create(input, { updatedBy: "user" });
      emit("taskChange", { action: "created", task });
      return { task };
    },

    "tasks.update": async (params: unknown) => {
      const { id, ...updates } = UpdateTaskSchema.parse(params);
      const task = taskStore.update(id, updates, { updatedBy: "user" });
      if (!task) throw new Error(`Task not found: ${id}`);
      emit("taskChange", { action: "updated", task });
      return { task };
    },

    "tasks.delete": async (params: unknown) => {
      const { id } = z.object({ id: z.string().min(1) }).parse(params);

      const deleted = taskStore.delete(id);
      if (!deleted) throw new Error(`Task not found: ${id}`);
      emit("taskChange", { action: "deleted", id });
      return { status: "ok" };
    },

    "tasks.reorder": async (params: unknown) => {
      const { status, orderedIds } = ReorderTasksSchema.parse(params);
      taskStore.reorder(status, orderedIds);
      emit("taskChange", { action: "reordered", status });
      return { status: "ok" };
    },

    "tasks.archiveDone": async (params: unknown) => {
      const { teamId, status } = ArchiveDoneSchema.parse(params ?? {});
      const doneStatus = resolveDoneStatus(status);
      const count = taskStore.archiveDone(teamId, doneStatus, "user");
      emit("taskChange", { action: "archived", count });
      return { archived: count };
    },

    "tasks.listComments": async (params: unknown) => {
      const { taskId } = ListTaskCommentsSchema.parse(params);
      const task = taskStore.getById(taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);
      return { comments: taskStore.listComments(taskId) };
    },

    "tasks.addComment": async (params: unknown) => {
      const { taskId, content } = AddTaskCommentSchema.parse(params);
      const comment = taskStore.addComment(taskId, content, { actor: "user" });
      if (!comment) throw new Error(`Task not found: ${taskId}`);
      emit("taskChange", { action: "commentAdded", taskId, comment });
      return { comment };
    },

    "tasks.updateComment": async (params: unknown) => {
      const { id, content } = UpdateTaskCommentSchema.parse(params);
      const comment = taskStore.updateComment(id, content, { actor: "user" });
      if (!comment) throw new Error(`Comment not found: ${id}`);
      emit("taskChange", { action: "commentUpdated", taskId: comment.taskId, comment });
      return { comment };
    },

    "tasks.deleteComment": async (params: unknown) => {
      const { id } = DeleteTaskCommentSchema.parse(params);
      const comment = taskStore.deleteComment(id, { actor: "user" });
      if (!comment) throw new Error(`Comment not found: ${id}`);
      emit("taskChange", { action: "commentDeleted", taskId: comment.taskId, id: comment.id });
      return { status: "ok" };
    },

    "tasks.uploadAttachment": async (params: unknown) => {
      const { name, type, data } = UploadAttachmentSchema.parse(params);

      if (!ALLOWED_IMAGE_TYPES.has(type)) {
        throw new Error("Unsupported image type. Allowed: png, jpg, gif, webp");
      }

      // Pre-check base64 string length to avoid unnecessary memory allocation
      if (data.length > MAX_BASE64_LENGTH) {
        throw new Error(`File exceeds ${MAX_FILE_SIZE / (1024 * 1024)}MB limit`);
      }

      const buf = Buffer.from(data, "base64");
      if (buf.length > MAX_FILE_SIZE) {
        throw new Error(`File exceeds ${MAX_FILE_SIZE / (1024 * 1024)}MB limit`);
      }

      const id = randomUUID();
      const ext = EXT_FOR_MIME[type] ?? ".bin";
      const diskName = `${id}${ext}`;
      const filePath = join(ATTACHMENTS_DIR, diskName);

      await writeFile(filePath, buf);
      logger.info(`Attachment saved: ${diskName} (${buf.length} bytes)`);

      const attachment: TaskAttachment = {
        id: diskName,
        name: name.replace(/[<>"'&]/g, "_").slice(0, 255),
        type,
        size: buf.length,
        createdAt: Date.now(),
      };
      return attachment;
    },

    "tasks.getAttachment": async (params: unknown) => {
      const { id } = GetAttachmentSchema.parse(params);

      // Guard against path traversal
      const safe = basename(id);
      if (safe !== id || id.startsWith(".")) {
        throw new Error("Invalid attachment id");
      }

      const filePath = join(ATTACHMENTS_DIR, safe);
      let buf: Buffer;
      try {
        buf = await readFile(filePath);
      } catch {
        throw new Error("Attachment not found");
      }
      const ext = extname(filePath);

      return { data: buf.toString("base64"), type: MIME_FOR_EXT[ext] ?? "application/octet-stream" };
    },
  };
}
