import { describe, expect, it, vi } from "vitest";
import { sessionMethods } from "./sessions.js";

interface SessionRow {
  key: string;
  file: string;
  messageCount: number;
  updatedAt: number;
  title?: string;
  teamId?: string;
}

function createAgentMock(options?: {
  sessions?: SessionRow[];
  teams?: Array<{ id: string; name?: string; color?: string }>;
  clearedCount?: number;
}) {
  const store = {
    list: vi.fn(() => options?.sessions ?? []),
    load: vi.fn(),
    rename: vi.fn(() => true),
  };
  return {
    getStore: vi.fn(() => store),
    getTeams: vi.fn(() => options?.teams ?? []),
    clearSession: vi.fn(async () => {}),
    clearOldSessions: vi.fn(async () => options?.clearedCount ?? 0),
  };
}

describe("sessionMethods", () => {
  it("sessions.list paginates and returns metadata", async () => {
    const sessions: SessionRow[] = [
      { key: "team-1:gateway:a", file: "a.jsonl", messageCount: 8, updatedAt: 300, teamId: "team-1" },
      { key: "team-2:gateway:b", file: "b.jsonl", messageCount: 3, updatedAt: 200, teamId: "team-2" },
      { key: "team-1:worker:c", file: "c.jsonl", messageCount: 1, updatedAt: 100, teamId: "team-1" },
    ];
    const agent = createAgentMock({
      sessions,
      teams: [{ id: "team-1", name: "Alpha", color: "#ff00aa" }],
    });
    const methods = sessionMethods(() => agent as any);

    const result = await methods["sessions.list"]({ limit: 2, offset: 0 }) as {
      sessions: SessionRow[];
      total: number;
      hasMore: boolean;
      nextOffset: number | null;
    };

    expect(result.total).toBe(3);
    expect(result.hasMore).toBe(true);
    expect(result.nextOffset).toBe(2);
    expect(result.sessions.map((session) => session.key)).toEqual([
      "team-1:gateway:a",
      "team-2:gateway:b",
    ]);
    expect(result.sessions[0]).toMatchObject({
      teamName: "Alpha",
      teamColor: "#ff00aa",
    });
    expect(result.sessions[1]).not.toHaveProperty("teamName");
  });

  it("sessions.list validates pagination params", async () => {
    const methods = sessionMethods(() => createAgentMock() as any);
    await expect(methods["sessions.list"]({ limit: 0 })).rejects.toThrow("limit must be a positive integer");
    await expect(methods["sessions.list"]({ offset: -1 })).rejects.toThrow("offset must be a non-negative integer");
    await expect(methods["sessions.list"]({ teamId: 123 as any })).rejects.toThrow("teamId must be a string");
  });

  it("sessions.list filters by teamId before pagination", async () => {
    const sessions: SessionRow[] = [
      { key: "team-2:gateway:b", file: "b.jsonl", messageCount: 3, updatedAt: 300 },
      { key: "team-1:gateway:a", file: "a.jsonl", messageCount: 8, updatedAt: 200, teamId: "team-1" },
      { key: "team-2:worker:c", file: "c.jsonl", messageCount: 1, updatedAt: 100, teamId: "team-2" },
    ];
    const agent = createAgentMock({
      sessions,
      teams: [{ id: "team-2", name: "Bravo", color: "#00aaff" }],
    });
    const methods = sessionMethods(() => agent as any);

    const result = await methods["sessions.list"]({ teamId: "team-2", limit: 1, offset: 0 }) as {
      sessions: SessionRow[];
      total: number;
      hasMore: boolean;
      nextOffset: number | null;
    };

    expect(result.total).toBe(2);
    expect(result.hasMore).toBe(true);
    expect(result.nextOffset).toBe(1);
    expect(result.sessions.map((session) => session.key)).toEqual(["team-2:gateway:b"]);
    expect(result.sessions[0]).toMatchObject({
      teamId: "team-2",
      teamName: "Bravo",
      teamColor: "#00aaff",
    });
  });

  it("sessions.clearOld keeps 300 sessions by default", async () => {
    const agent = createAgentMock({ clearedCount: 25 });
    const methods = sessionMethods(() => agent as any);

    const result = await methods["sessions.clearOld"]();

    expect(agent.clearOldSessions).toHaveBeenCalledWith(300, undefined);
    expect(result).toEqual({
      status: "ok",
      keepLatest: 300,
      cleared: 25,
    });
  });

  it("sessions.clearOld scopes by team when teamId is provided", async () => {
    const agent = createAgentMock({ clearedCount: 3 });
    const methods = sessionMethods(() => agent as any);

    const result = await methods["sessions.clearOld"]({ keepLatest: 25, teamId: "team-2" });

    expect(agent.clearOldSessions).toHaveBeenCalledWith(25, "team-2");
    expect(result).toEqual({
      status: "ok",
      keepLatest: 25,
      cleared: 3,
    });
  });

  it("sessions.clearOld validates keepLatest", async () => {
    const methods = sessionMethods(() => createAgentMock() as any);
    await expect(methods["sessions.clearOld"]({ keepLatest: -2 })).rejects.toThrow(
      "keepLatest must be a non-negative integer",
    );
    await expect(methods["sessions.clearOld"]({ teamId: 123 as any })).rejects.toThrow("teamId must be a string");
  });
});
