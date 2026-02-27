import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import Database from "better-sqlite3";
import { TaskStore } from "./store.js";

let tmpDir: string | null = null;
let store: TaskStore | null = null;

function makeDbPath(): string {
  tmpDir = mkdtempSync(join(tmpdir(), "task-store-test-"));
  return join(tmpDir, "test.db");
}

afterEach(() => {
  store?.close();
  store = null;
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
});

describe("TaskStore — incremental ids", () => {
  it("assigns incremental ids starting at 1", async () => {
    const dbPath = makeDbPath();
    store = await TaskStore.create(dbPath);

    const t1 = store.create({ title: "First task" });
    const t2 = store.create({ title: "Second task" });
    const t3 = store.create({ title: "Third task" });

    expect(t1.id).toBe("1");
    expect(t2.id).toBe("2");
    expect(t3.id).toBe("3");
  });

  it("continues ids across restarts", async () => {
    const dbPath = makeDbPath();
    store = await TaskStore.create(dbPath);
    store.create({ title: "A" });
    store.create({ title: "B" });
    store.close();
    store = null;

    store = await TaskStore.create(dbPath);
    const next = store.create({ title: "C" });
    expect(next.id).toBe("3");
  });

  it("initializes counter from highest numeric legacy id", async () => {
    const dbPath = makeDbPath();
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        team_id TEXT,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'todo',
        assignee TEXT,
        priority TEXT NOT NULL DEFAULT 'medium',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    const now = Date.now();
    db.prepare(
      `INSERT INTO tasks (id, team_id, title, description, status, assignee, priority, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("12", null, "Legacy numeric", null, "todo", null, "medium", now, now);
    db.prepare(
      `INSERT INTO tasks (id, team_id, title, description, status, assignee, priority, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("e8956c15", null, "Legacy hex", null, "todo", null, "medium", now, now);
    db.close();

    store = await TaskStore.create(dbPath);
    const created = store.create({ title: "After migration" });

    expect(created.id).toBe("13");
  });
});

describe("TaskStore — claim behavior on status changes", () => {
  it("clears claim by default when status changes", async () => {
    const dbPath = makeDbPath();
    store = await TaskStore.create(dbPath);

    const task = store.create({ title: "Claimed task", status: "todo" });
    store.claimTaskById(task.id, "agent-a");

    const updated = store.update(task.id, { status: "in_progress" });
    expect(updated?.status).toBe("in_progress");
    expect(updated?.claimedBy).toBeNull();
    expect(updated?.claimedAt).toBeNull();
  });

  it("keeps claim when clearClaimOnStatusChange is false", async () => {
    const dbPath = makeDbPath();
    store = await TaskStore.create(dbPath);

    const task = store.create({ title: "Strict pipeline task", status: "todo" });
    store.claimTaskById(task.id, "agent-a");

    const updated = store.update(task.id, { status: "in_progress" }, { clearClaimOnStatusChange: false });
    expect(updated?.status).toBe("in_progress");
    expect(updated?.claimedBy).toBe("agent-a");
    expect(typeof updated?.claimedAt).toBe("number");
  });

  it("releases claim only for the matching claim owner", async () => {
    const dbPath = makeDbPath();
    store = await TaskStore.create(dbPath);

    const task = store.create({ title: "Owner-checked release", status: "todo" });
    store.claimTaskById(task.id, "agent-a");

    expect(store.releaseTaskIfClaimedBy(task.id, "agent-b")).toBe(false);
    expect(store.getById(task.id)?.claimedBy).toBe("agent-a");

    expect(store.releaseTaskIfClaimedBy(task.id, "agent-a")).toBe(true);
    expect(store.getById(task.id)?.claimedBy).toBeNull();
  });

  it("prevents the same agent from reclaiming an unchanged finalized task", async () => {
    const dbPath = makeDbPath();
    store = await TaskStore.create(dbPath);

    const task = store.create({ title: "No repeat", status: "todo" });
    expect(store.claimTaskById(task.id, "agent-a")).not.toBeNull();

    expect(store.finalizeClaimedTaskRun(task.id, "agent-a")).toBe(true);
    expect(store.getById(task.id)?.claimedBy).toBeNull();

    const sameAgentReclaim = store.claimTask("agent-a", "todo");
    expect(sameAgentReclaim).toBeNull();
  });

  it("does not make finalized tasks claimable again when only reordered", async () => {
    const dbPath = makeDbPath();
    store = await TaskStore.create(dbPath);

    const planStatus = "plan";
    const agentId = "agent-a";
    const first = store.create({ title: "First", status: planStatus });
    const second = store.create({ title: "Second", status: planStatus });
    const third = store.create({ title: "Third", status: planStatus });
    const originalTaskIds = [first.id, second.id, third.id];

    for (const taskId of originalTaskIds) {
      expect(store.claimTaskById(taskId, agentId)).not.toBeNull();
      expect(store.finalizeClaimedTaskRun(taskId, agentId)).toBe(true);
    }

    const updatedAtBeforeReorder = new Map(
      originalTaskIds.map((taskId) => [taskId, store!.getById(taskId)?.updatedAt ?? null]),
    );
    store.reorder(planStatus, [third.id, first.id, second.id]);

    for (const taskId of originalTaskIds) {
      const task = store.getById(taskId);
      expect(task?.updatedAt ?? null).toBe(updatedAtBeforeReorder.get(taskId));
    }
    expect(store.claimTask(agentId, planStatus)).toBeNull();
  });

  it("allows another agent to claim after a different agent finalized", async () => {
    const dbPath = makeDbPath();
    store = await TaskStore.create(dbPath);

    const task = store.create({ title: "Cross-agent claim", status: "todo" });
    expect(store.claimTaskById(task.id, "agent-a")).not.toBeNull();
    expect(store.finalizeClaimedTaskRun(task.id, "agent-a")).toBe(true);

    const otherAgentClaim = store.claimTask("agent-b", "todo");
    expect(otherAgentClaim?.id).toBe(task.id);
    expect(otherAgentClaim?.claimedBy).toBe("agent-b");
  });

  it("does not allow claiming tasks that need human review", async () => {
    const dbPath = makeDbPath();
    store = await TaskStore.create(dbPath);

    const task = store.create({ title: "Human review gate", status: "todo", needsHumanReview: true });

    expect(store.claimTask("agent-a", "todo")).toBeNull();
    expect(store.claimTaskById(task.id, "agent-a")).toBeNull();
    expect(store.getById(task.id)?.claimedBy).toBeNull();
  });
});

describe("TaskStore — update audit metadata", () => {
  it("tracks updatedBy on create and update", async () => {
    const dbPath = makeDbPath();
    store = await TaskStore.create(dbPath);

    const created = store.create({ title: "Audit task", status: "todo" }, { updatedBy: "user" });
    expect(created.updatedBy).toBe("user");

    const updated = store.update(created.id, { status: "in_progress" }, { updatedBy: "agent-a" });
    expect(updated?.updatedBy).toBe("agent-a");
    expect(typeof updated?.updatedAt).toBe("number");
  });

  it("defaults updatedBy to system when actor is omitted", async () => {
    const dbPath = makeDbPath();
    store = await TaskStore.create(dbPath);

    const created = store.create({ title: "Default actor task", status: "todo" });
    expect(created.updatedBy).toBe("system");

    const updated = store.update(created.id, { title: "Renamed" });
    expect(updated?.updatedBy).toBe("system");
  });

  it("clears needsHumanReview automatically when updated by a human", async () => {
    const dbPath = makeDbPath();
    store = await TaskStore.create(dbPath);

    const created = store.create({ title: "Needs review", status: "todo", needsHumanReview: true }, { updatedBy: "assistant" });
    expect(created.needsHumanReview).toBe(true);

    const updated = store.update(created.id, { title: "Reviewed by human" }, { updatedBy: "user" });
    expect(updated?.needsHumanReview).toBe(false);
    expect(store.getById(created.id)?.needsHumanReview).toBe(false);
  });

  it("keeps needsHumanReview when human explicitly sets it to true", async () => {
    const dbPath = makeDbPath();
    store = await TaskStore.create(dbPath);

    const created = store.create({ title: "Review requested", status: "todo", needsHumanReview: true }, { updatedBy: "assistant" });
    const updated = store.update(
      created.id,
      { title: "Still waiting", needsHumanReview: true },
      { updatedBy: "user" },
    );
    expect(updated?.needsHumanReview).toBe(true);
    expect(store.getById(created.id)?.needsHumanReview).toBe(true);
  });
});

describe("TaskStore — archive behavior", () => {
  it("archives tasks using the provided done status key", async () => {
    const dbPath = makeDbPath();
    store = await TaskStore.create(dbPath);

    const completed = store.create({ title: "Completed", teamId: "team-a", status: "completed" });
    store.create({ title: "Still open", teamId: "team-a", status: "todo" });
    store.create({ title: "Default done", teamId: "team-a", status: "done" });

    const archivedCount = store.archiveDone("team-a", "completed");

    expect(archivedCount).toBe(1);
    expect(store.getById(completed.id)?.status).toBe("archived");
    expect(store.list({ teamId: "team-a", status: "done" })).toHaveLength(1);
  });

  it("defaults to archiving status 'done' when no done status key is provided", async () => {
    const dbPath = makeDbPath();
    store = await TaskStore.create(dbPath);

    const doneTask = store.create({ title: "Done", teamId: "team-a", status: "done" });
    store.create({ title: "Completed", teamId: "team-a", status: "completed" });

    const archivedCount = store.archiveDone("team-a");

    expect(archivedCount).toBe(1);
    expect(store.getById(doneTask.id)?.status).toBe("archived");
    expect(store.list({ teamId: "team-a", status: "completed" })).toHaveLength(1);
  });
});

describe("TaskStore — needsHumanReview filtering", () => {
  it("defaults needsHumanReview to false for new tasks", async () => {
    const dbPath = makeDbPath();
    store = await TaskStore.create(dbPath);

    const task = store.create({ title: "Default review state", status: "todo" });
    expect(task.needsHumanReview).toBe(false);
    expect(store.getById(task.id)?.needsHumanReview).toBe(false);
  });

  it("filters tasks by needsHumanReview", async () => {
    const dbPath = makeDbPath();
    store = await TaskStore.create(dbPath);

    const waiting = store.create({ title: "Waiting for human", status: "todo", needsHumanReview: true });
    const normal = store.create({ title: "No human review", status: "todo", needsHumanReview: false });

    const waitingOnly = store.list({ needsHumanReview: true });
    const normalOnly = store.list({ needsHumanReview: false });

    expect(waitingOnly.map((task) => task.id)).toEqual([waiting.id]);
    expect(normalOnly.map((task) => task.id)).toEqual([normal.id]);
  });
});

describe("TaskStore — comments", () => {
  it("adds, lists, updates, and deletes comments with actor metadata", async () => {
    const dbPath = makeDbPath();
    store = await TaskStore.create(dbPath);

    const task = store.create({ title: "Comment target", status: "todo" }, { updatedBy: "user" });
    const created = store.addComment(task.id, "First comment", { actor: "agent-a" });

    expect(created).not.toBeNull();
    expect(created?.taskId).toBe(task.id);
    expect(created?.content).toBe("First comment");
    expect(created?.createdBy).toBe("agent-a");
    expect(created?.updatedBy).toBe("agent-a");

    const listed = store.listComments(task.id);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(created?.id);

    const updated = store.updateComment(created!.id, "Edited comment", { actor: "user" });
    expect(updated).not.toBeNull();
    expect(updated?.content).toBe("Edited comment");
    expect(updated?.updatedBy).toBe("user");
    expect((updated?.updatedAt ?? 0) >= (updated?.createdAt ?? 0)).toBe(true);

    const fetched = store.getCommentById(created!.id);
    expect(fetched?.content).toBe("Edited comment");
    expect(fetched?.updatedBy).toBe("user");

    const deleted = store.deleteComment(created!.id, { actor: "agent-a" });
    expect(deleted?.id).toBe(created?.id);
    expect(store.listComments(task.id)).toHaveLength(0);
  });

  it("returns null when adding/updating/deleting comments for missing records", async () => {
    const dbPath = makeDbPath();
    store = await TaskStore.create(dbPath);

    expect(store.addComment("missing-task", "Hello", { actor: "user" })).toBeNull();
    expect(store.updateComment("missing-comment", "Hello", { actor: "user" })).toBeNull();
    expect(store.deleteComment("missing-comment", { actor: "user" })).toBeNull();
  });

  it("deletes task comments when deleting a task", async () => {
    const dbPath = makeDbPath();
    store = await TaskStore.create(dbPath);

    const task = store.create({ title: "Task with comments", status: "todo" });
    const comment = store.addComment(task.id, "Will be removed");
    expect(comment).not.toBeNull();
    expect(store.listComments(task.id)).toHaveLength(1);

    expect(store.delete(task.id)).toBe(true);
    expect(store.listComments(task.id)).toHaveLength(0);
    expect(store.getCommentById(comment!.id)).toBeNull();
  });

  it("clears needsHumanReview when a human adds a comment", async () => {
    const dbPath = makeDbPath();
    store = await TaskStore.create(dbPath);

    const task = store.create(
      { title: "Awaiting human input", status: "todo", needsHumanReview: true },
      { updatedBy: "assistant" },
    );
    expect(store.getById(task.id)?.needsHumanReview).toBe(true);

    const comment = store.addComment(task.id, "I reviewed this", { actor: "user" });
    expect(comment).not.toBeNull();
    expect(store.getById(task.id)?.needsHumanReview).toBe(false);
  });

  it("clears needsHumanReview when a human updates a comment", async () => {
    const dbPath = makeDbPath();
    store = await TaskStore.create(dbPath);

    const task = store.create(
      { title: "Awaiting feedback", status: "todo", needsHumanReview: true },
      { updatedBy: "assistant" },
    );
    const comment = store.addComment(task.id, "Please clarify", { actor: "assistant" });
    expect(comment).not.toBeNull();
    expect(store.getById(task.id)?.needsHumanReview).toBe(true);

    const updated = store.updateComment(comment!.id, "Here is clarification", { actor: "user" });
    expect(updated).not.toBeNull();
    expect(store.getById(task.id)?.needsHumanReview).toBe(false);
  });

  it("keeps needsHumanReview when a non-human edits a comment", async () => {
    const dbPath = makeDbPath();
    store = await TaskStore.create(dbPath);

    const task = store.create(
      { title: "Still waiting", status: "todo", needsHumanReview: true },
      { updatedBy: "assistant" },
    );
    const comment = store.addComment(task.id, "Needs more details", { actor: "assistant" });
    expect(comment).not.toBeNull();
    expect(store.getById(task.id)?.needsHumanReview).toBe(true);

    const updated = store.updateComment(comment!.id, "Still needs more details", { actor: "assistant" });
    expect(updated).not.toBeNull();
    expect(store.getById(task.id)?.needsHumanReview).toBe(true);
  });
});
