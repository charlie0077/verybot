import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { TaskStore } from "../tasks/store.js";
import { createTaskTools } from "./tasks.js";
import type { TaskStatusConfig } from "../tasks/types.js";

let tmpDir: string | null = null;
let store: TaskStore | null = null;

async function createStore(): Promise<TaskStore> {
  tmpDir = mkdtempSync(join(tmpdir(), "task-tools-test-"));
  const dbPath = join(tmpDir, "test.db");
  store = await TaskStore.create(dbPath);
  return store;
}

afterEach(() => {
  store?.close();
  store = null;
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
});

describe("createTaskTools", () => {
  it("defaults task_create to a team status when todo is not configured", async () => {
    const taskStore = await createStore();
    const statuses: TaskStatusConfig[] = [
      { key: "queued", label: "Queued", color: "#64748b" },
      { key: "doing", label: "Doing", color: "#f59e0b" },
      { key: "done_custom", label: "Done", color: "#22c55e" },
    ];

    const tools = createTaskTools(taskStore, "team-a", statuses);
    const taskCreate = tools.task_create as unknown as { execute: (input: { title: string }) => Promise<string> };
    await taskCreate.execute({ title: "status fallback" });

    const created = taskStore.list({ teamId: "team-a" });
    expect(created).toHaveLength(1);
    expect(created[0]?.status).toBe("queued");
  });

  it("allows task_create to set an explicit team-specific status", async () => {
    const taskStore = await createStore();
    const statuses: TaskStatusConfig[] = [
      { key: "queued", label: "Queued", color: "#64748b" },
      { key: "in_review", label: "In Review", color: "#f59e0b" },
      { key: "done_custom", label: "Done", color: "#22c55e" },
    ];

    const tools = createTaskTools(taskStore, "team-a", statuses);
    const taskCreate = tools.task_create as unknown as {
      execute: (input: { title: string; status: string }) => Promise<string>
    };
    await taskCreate.execute({ title: "custom status", status: "in_review" });

    const created = taskStore.list({ teamId: "team-a" });
    expect(created).toHaveLength(1);
    expect(created[0]?.status).toBe("in_review");
  });

  it("keeps todo as default when it exists in the configured statuses", async () => {
    const taskStore = await createStore();
    const tools = createTaskTools(taskStore, "team-a");
    const taskCreate = tools.task_create as unknown as { execute: (input: { title: string }) => Promise<string> };
    await taskCreate.execute({ title: "default status" });

    const created = taskStore.list({ teamId: "team-a" });
    expect(created).toHaveLength(1);
    expect(created[0]?.status).toBe("todo");
  });

  it("keeps claim during status transitions in strict handoff mode", async () => {
    const taskStore = await createStore();
    const claimedTask = taskStore.create({ title: "strict transition", teamId: "team-a", status: "todo" });
    taskStore.claimTaskById(claimedTask.id, "agent-a");

    const tools = createTaskTools(taskStore, "team-a", undefined, {
      clearClaimOnStatusChange: false,
      requireClaimedByForStatusChange: "agent-a",
    });
    const taskUpdate = tools.task_update as unknown as {
      execute: (input: { id: string; status: string }) => Promise<string>
    };
    await taskUpdate.execute({ id: claimedTask.id, status: "in_progress" });

    const updated = taskStore.getById(claimedTask.id);
    expect(updated?.status).toBe("in_progress");
    expect(updated?.claimedBy).toBe("agent-a");
  });

  it("blocks strict status transition when task is claimed by another agent", async () => {
    const taskStore = await createStore();
    const claimedTask = taskStore.create({ title: "guarded transition", teamId: "team-a", status: "todo" });
    taskStore.claimTaskById(claimedTask.id, "agent-b");

    const tools = createTaskTools(taskStore, "team-a", undefined, {
      clearClaimOnStatusChange: false,
      requireClaimedByForStatusChange: "agent-a",
    });
    const taskUpdate = tools.task_update as unknown as {
      execute: (input: { id: string; status: string }) => Promise<string>
    };
    const result = await taskUpdate.execute({ id: claimedTask.id, status: "in_progress" });

    const unchanged = taskStore.getById(claimedTask.id);
    expect(result).toContain("Task status update blocked");
    expect(unchanged?.status).toBe("todo");
    expect(unchanged?.claimedBy).toBe("agent-b");
  });

  it("includes claim metadata in task_list output", async () => {
    const taskStore = await createStore();
    const claimedTask = taskStore.create({ title: "claimed task", teamId: "team-a", status: "todo" });
    taskStore.claimTaskById(claimedTask.id, "agent-a");
    taskStore.create({ title: "unclaimed task", teamId: "team-a", status: "todo", needsHumanReview: true });

    const tools = createTaskTools(taskStore, "team-a");
    const taskList = tools.task_list as unknown as {
      execute: (input: { status?: string; team?: string }) => Promise<string>
    };
    const result = await taskList.execute({});

    expect(result).toContain("claimed_by: agent-a");
    expect(result).toContain("claimed_at:");
    expect(result).toContain("needs_human_review: no");
    expect(result).toContain("needs_human_review: yes");
    expect(result).toContain("claimed_by: none");
    expect(result).toContain("claimed_at: none");
    expect(result).toContain("updated_by:");
    expect(result).toContain("updated_at:");
  });

  it("allows task_update to set needsHumanReview", async () => {
    const taskStore = await createStore();
    const task = taskStore.create({ title: "Needs flag update", teamId: "team-a", status: "todo" });

    const tools = createTaskTools(taskStore, "team-a");
    const taskUpdate = tools.task_update as unknown as {
      execute: (input: { id: string; needsHumanReview: boolean }) => Promise<string>
    };
    const result = await taskUpdate.execute({ id: task.id, needsHumanReview: true });

    expect(result).toContain(`Task updated: [${task.id}]`);
    expect(taskStore.getById(task.id)?.needsHumanReview).toBe(true);
  });

  it("returns full task details with description and comments via task_get", async () => {
    const taskStore = await createStore();
    const task = taskStore.create({
      title: "Detailed task",
      description: "Sync README and release notes.",
      teamId: "team-a",
      status: "todo",
      attachments: [{
        id: "123e4567-e89b-12d3-a456-426614174000.png",
        name: "screenshot.png",
        type: "image/png",
        size: 1024,
        createdAt: Date.now(),
      }],
    });
    taskStore.addComment(task.id, "Please include migration notes.", { actor: "reviewer" });

    const tools = createTaskTools(taskStore, "team-a");
    const taskGet = tools.task_get as unknown as {
      execute: (input: { id: string }) => Promise<string>
    };
    const result = await taskGet.execute({ id: task.id });

    expect(result).toContain(`Task: [${task.id}] Detailed task`);
    expect(result).toContain("Description:");
    expect(result).toContain("Sync README and release notes.");
    expect(result).toContain("Attachments:");
    expect(result).toContain("screenshot.png");
    expect(result).toContain("Comments:");
    expect(result).toContain("Please include migration notes.");
  });

  it("scopes task_get to the configured team", async () => {
    const taskStore = await createStore();
    const otherTeamTask = taskStore.create({ title: "Other team task", teamId: "team-b", status: "todo" });
    const tools = createTaskTools(taskStore, "team-a");

    const taskGet = tools.task_get as unknown as {
      execute: (input: { id: string }) => Promise<string>
    };
    const result = await taskGet.execute({ id: otherTeamTask.id });

    expect(result).toBe(`Task not found: ${otherTeamTask.id}`);
  });

  it("supports comment CRUD tools for task comments", async () => {
    const taskStore = await createStore();
    const task = taskStore.create({ title: "Comment task", teamId: "team-a", status: "todo" });
    const tools = createTaskTools(taskStore, "team-a");

    const addComment = tools.task_comment_add as unknown as {
      execute: (input: { taskId: string; content: string }) => Promise<string>
    };
    const listComments = tools.task_comment_list as unknown as {
      execute: (input: { taskId: string }) => Promise<string>
    };
    const updateComment = tools.task_comment_update as unknown as {
      execute: (input: { id: string; content: string }) => Promise<string>
    };
    const deleteComment = tools.task_comment_delete as unknown as {
      execute: (input: { id: string }) => Promise<string>
    };

    const addResult = await addComment.execute({ taskId: task.id, content: "Initial note" });
    expect(addResult).toContain("Comment added:");

    const created = taskStore.listComments(task.id);
    expect(created).toHaveLength(1);
    const commentId = created[0]!.id;

    const listResult = await listComments.execute({ taskId: task.id });
    expect(listResult).toContain(commentId);
    expect(listResult).toContain("Initial note");

    const updateResult = await updateComment.execute({ id: commentId, content: "Updated note" });
    expect(updateResult).toContain("Comment updated:");
    expect(taskStore.getCommentById(commentId)?.content).toBe("Updated note");

    const deleteResult = await deleteComment.execute({ id: commentId });
    expect(deleteResult).toContain("Comment deleted:");
    expect(taskStore.getCommentById(commentId)).toBeNull();
  });

  it("scopes comment tools to the configured team", async () => {
    const taskStore = await createStore();
    const otherTeamTask = taskStore.create({ title: "Other team task", teamId: "team-b", status: "todo" });
    const tools = createTaskTools(taskStore, "team-a");

    const addComment = tools.task_comment_add as unknown as {
      execute: (input: { taskId: string; content: string }) => Promise<string>
    };
    const addResult = await addComment.execute({ taskId: otherTeamTask.id, content: "Should fail" });

    expect(addResult).toBe(`Task not found: ${otherTeamTask.id}`);
    expect(taskStore.listComments(otherTeamTask.id)).toHaveLength(0);
  });
});
