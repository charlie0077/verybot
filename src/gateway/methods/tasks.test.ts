import { describe, expect, it, vi } from "vitest";
import { taskMethods } from "./tasks.js";

describe("taskMethods task CRUD", () => {
  it("passes needsHumanReview filter through tasks.list", async () => {
    const list = vi.fn(() => []);
    const getClaimsForTasks = vi.fn(() => new Map());
    const taskStore = { list, getClaimsForTasks } as unknown as Parameters<typeof taskMethods>[0];
    const methods = taskMethods(taskStore);

    const result = await methods["tasks.list"]({ needsHumanReview: true });

    expect(list).toHaveBeenCalledWith({ needsHumanReview: true });
    expect(result).toEqual({ tasks: [] });
  });

  it("passes needsHumanReview through tasks.update with user actor", async () => {
    const task = {
      id: "task-1",
      title: "updated",
      status: "todo",
      priority: "medium",
      teamId: "team-1",
      description: null,
      assignee: null,
      position: 0,
      attachments: [],
      needsHumanReview: true,
      claimedBy: null,
      claimedAt: null,
      updatedBy: "user",
      createdAt: 1,
      updatedAt: 2,
    };
    const update = vi.fn(() => task);
    const getById = vi.fn(() => task);
    const clearAllClaimsForTask = vi.fn();
    const taskStore = { update, getById, clearAllClaimsForTask } as unknown as Parameters<typeof taskMethods>[0];
    const methods = taskMethods(taskStore);

    const result = await methods["tasks.update"]({ id: "task-1", title: "updated", needsHumanReview: true });

    expect(update).toHaveBeenCalledWith(
      "task-1",
      { title: "updated", needsHumanReview: true },
      { updatedBy: "user" },
    );
    expect(result).toEqual({ task });
  });
});

describe("taskMethods archiveDone", () => {
  it("defaults to explicit done status key even when team statuses are ordered differently", async () => {
    const archiveDone = vi.fn(() => 2);
    const taskStore = { archiveDone } as unknown as Parameters<typeof taskMethods>[0];
    const teamStore = {
      getTeamById: vi.fn(() => ({
        statuses: [
          { key: "done", label: "Done", color: "#22c55e" },
          { key: "todo", label: "Todo", color: "#64748b" },
          { key: "in_progress", label: "In Progress", color: "#f59e0b" },
          { key: "completed", label: "Completed", color: "#22c55e" },
        ],
      })),
    } as unknown as Parameters<typeof taskMethods>[1];

    const methods = taskMethods(taskStore, teamStore);
    const result = await methods["tasks.archiveDone"]({ teamId: "team-1" });

    expect(archiveDone).toHaveBeenCalledWith("team-1", "done", "user");
    expect(result).toEqual({ archived: 2 });
  });

  it("prefers explicit status when provided", async () => {
    const archiveDone = vi.fn(() => 1);
    const taskStore = { archiveDone } as unknown as Parameters<typeof taskMethods>[0];
    const teamStore = {
      getTeamById: vi.fn(() => ({
        statuses: [
          { key: "todo", label: "Todo", color: "#64748b" },
          { key: "completed", label: "Completed", color: "#22c55e" },
        ],
      })),
    } as unknown as Parameters<typeof taskMethods>[1];

    const methods = taskMethods(taskStore, teamStore);
    const result = await methods["tasks.archiveDone"]({ teamId: "team-1", status: "verified" });

    expect(archiveDone).toHaveBeenCalledWith("team-1", "verified", "user");
    expect(result).toEqual({ archived: 1 });
  });
});

describe("taskMethods comments", () => {
  it("lists comments for an existing task", async () => {
    const listComments = vi.fn(() => [
      {
        id: "comment-1",
        taskId: "task-1",
        content: "hello",
        createdBy: "user",
        updatedBy: "user",
        createdAt: 100,
        updatedAt: 100,
      },
    ]);
    const taskStore = {
      getById: vi.fn(() => ({ id: "task-1" })),
      listComments,
    } as unknown as Parameters<typeof taskMethods>[0];

    const methods = taskMethods(taskStore);
    const result = await methods["tasks.listComments"]({ taskId: "task-1" });

    expect(listComments).toHaveBeenCalledWith("task-1");
    expect(result).toEqual({
      comments: [
        {
          id: "comment-1",
          taskId: "task-1",
          content: "hello",
          createdBy: "user",
          updatedBy: "user",
          createdAt: 100,
          updatedAt: 100,
        },
      ],
    });
  });

  it("adds, updates, and deletes comments", async () => {
    const created = {
      id: "comment-1",
      taskId: "task-1",
      content: "hello",
      createdBy: "user",
      updatedBy: "user",
      createdAt: 100,
      updatedAt: 100,
    };
    const updated = {
      ...created,
      content: "updated",
      updatedAt: 200,
    };
    const taskStore = {
      addComment: vi.fn(() => created),
      updateComment: vi.fn(() => updated),
      deleteComment: vi.fn(() => updated),
    } as unknown as Parameters<typeof taskMethods>[0];

    const methods = taskMethods(taskStore);
    const addResult = await methods["tasks.addComment"]({ taskId: "task-1", content: "hello" });
    const updateResult = await methods["tasks.updateComment"]({ id: "comment-1", content: "updated" });
    const deleteResult = await methods["tasks.deleteComment"]({ id: "comment-1" });

    expect(taskStore.addComment).toHaveBeenCalledWith("task-1", "hello", { actor: "user" });
    expect(taskStore.updateComment).toHaveBeenCalledWith("comment-1", "updated", { actor: "user" });
    expect(taskStore.deleteComment).toHaveBeenCalledWith("comment-1", { actor: "user" });
    expect(addResult).toEqual({ comment: created });
    expect(updateResult).toEqual({ comment: updated });
    expect(deleteResult).toEqual({ status: "ok" });
  });

  it("throws when comment target is missing", async () => {
    const taskStore = {
      getById: vi.fn(() => null),
      addComment: vi.fn(() => null),
      updateComment: vi.fn(() => null),
      deleteComment: vi.fn(() => null),
    } as unknown as Parameters<typeof taskMethods>[0];
    const methods = taskMethods(taskStore);

    await expect(methods["tasks.listComments"]({ taskId: "task-404" })).rejects.toThrow("Task not found: task-404");
    await expect(methods["tasks.addComment"]({ taskId: "task-404", content: "hello" })).rejects.toThrow("Task not found: task-404");
    await expect(methods["tasks.updateComment"]({ id: "comment-404", content: "hello" })).rejects.toThrow("Comment not found: comment-404");
    await expect(methods["tasks.deleteComment"]({ id: "comment-404" })).rejects.toThrow("Comment not found: comment-404");
  });
});
