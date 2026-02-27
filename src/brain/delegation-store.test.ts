import { describe, it, expect, afterEach } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { unlinkSync } from "fs";
import { DelegationStore } from "./delegation-store.js";

function tmpDb(): string {
  return join(tmpdir(), `test-delegation-${randomUUID()}.db`);
}

describe("DelegationStore", () => {
  const cleanupPaths: string[] = [];

  afterEach(() => {
    for (const p of cleanupPaths) {
      try { unlinkSync(p); } catch {}
      try { unlinkSync(p + "-wal"); } catch {}
      try { unlinkSync(p + "-shm"); } catch {}
    }
    cleanupPaths.length = 0;
  });

  async function createStore() {
    const path = tmpDb();
    cleanupPaths.push(path);
    return DelegationStore.create(path);
  }

  it("inserts and retrieves a delegation record", async () => {
    const store = await createStore();
    const id = "abc12345";

    store.insert({
      id,
      agentId: "researcher",
      sessionKey: "sess-1",
      task: "find latest news",
      channelId: null,
      status: "running",
      createdAt: Date.now(),
    });

    const record = store.getById(id);
    expect(record).not.toBeNull();
    expect(record!.id).toBe(id);
    expect(record!.agentId).toBe("researcher");
    expect(record!.sessionKey).toBe("sess-1");
    expect(record!.task).toBe("find latest news");
    expect(record!.status).toBe("running");
    expect(record!.result).toBeNull();
    expect(record!.error).toBeNull();
    store.close();
  });

  it("marks a delegation as completed", async () => {
    const store = await createStore();
    const id = "comp-001";

    store.insert({
      id,
      agentId: "coder",
      sessionKey: "sess-2",
      task: "write a function",
      channelId: null,
      status: "running",
      createdAt: Date.now(),
    });

    store.markCompleted(id, "function written successfully");

    const record = store.getById(id);
    expect(record!.status).toBe("completed");
    expect(record!.result).toBe("function written successfully");
    expect(record!.completedAt).toBeTypeOf("number");
    store.close();
  });

  it("marks a delegation as failed", async () => {
    const store = await createStore();
    const id = "fail-001";

    store.insert({
      id,
      agentId: "researcher",
      sessionKey: "sess-3",
      task: "search web",
      channelId: null,
      status: "running",
      createdAt: Date.now(),
    });

    store.markFailed(id, "network timeout");

    const record = store.getById(id);
    expect(record!.status).toBe("failed");
    expect(record!.error).toBe("network timeout");
    expect(record!.completedAt).toBeTypeOf("number");
    store.close();
  });

  it("returns null for non-existent ID", async () => {
    const store = await createStore();
    expect(store.getById("nonexistent")).toBeNull();
    store.close();
  });

  it("lists delegations by session key", async () => {
    const store = await createStore();
    const now = Date.now();

    store.insert({ id: "a1", agentId: "r", sessionKey: "sess-A", task: "t1", channelId: null, status: "running", createdAt: now });
    store.insert({ id: "a2", agentId: "c", sessionKey: "sess-A", task: "t2", channelId: null, status: "running", createdAt: now + 1 });
    store.insert({ id: "b1", agentId: "r", sessionKey: "sess-B", task: "t3", channelId: null, status: "running", createdAt: now });

    store.markCompleted("a1", "done");

    const allA = store.listBySession("sess-A");
    expect(allA).toHaveLength(2);

    const completedA = store.listBySession("sess-A", "completed");
    expect(completedA).toHaveLength(1);
    expect(completedA[0].id).toBe("a1");

    const runningA = store.listBySession("sess-A", "running");
    expect(runningA).toHaveLength(1);
    expect(runningA[0].id).toBe("a2");

    const allB = store.listBySession("sess-B");
    expect(allB).toHaveLength(1);

    store.close();
  });

  it("cleans up old completed/failed delegations", async () => {
    const store = await createStore();
    const oldTime = Date.now() - 100_000;

    store.insert({ id: "old1", agentId: "r", sessionKey: "s", task: "t", channelId: null, status: "running", createdAt: oldTime });
    store.markCompleted("old1", "done");

    store.insert({ id: "new1", agentId: "r", sessionKey: "s", task: "t", channelId: null, status: "running", createdAt: Date.now() });
    store.markCompleted("new1", "done");

    // Cleanup with 0ms age removes everything that's completed (completed_at <= now)
    const removed2 = store.cleanup(0);
    expect(removed2).toBe(2); // both old1 and new1

    // Running tasks should survive cleanup
    store.insert({ id: "run1", agentId: "r", sessionKey: "s", task: "t", channelId: null, status: "running", createdAt: Date.now() });
    const removed3 = store.cleanup(0);
    expect(removed3).toBe(0);

    expect(store.getById("run1")).not.toBeNull();
    store.close();
  });
});
