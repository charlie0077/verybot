import { describe, expect, it, vi } from "vitest";
import { teamMethods } from "./teams.js";

function createTeamStoreStub() {
  return {
    transaction: vi.fn((fn: () => unknown) => fn()),
    toTeamConfigs: vi.fn(() => []),
    updateTeam: vi.fn(() => ({
      id: "team-1",
      name: "Team 1",
      color: "",
      workspace: "",
      statuses: undefined,
      createdAt: 0,
      updatedAt: 0,
    })),
  };
}

describe("teamMethods status validation", () => {
  it("rejects empty status arrays for teams.update", async () => {
    const teamStore = createTeamStoreStub();
    const methods = teamMethods(teamStore as never);

    await expect(
      methods["teams.update"]({ id: "team-1", statuses: [] }),
    ).rejects.toThrow("statuses must contain at least one status");

    expect(teamStore.updateTeam).not.toHaveBeenCalled();
  });

  it("rejects empty status arrays for teams.save", async () => {
    const teamStore = createTeamStoreStub();
    const methods = teamMethods(teamStore as never);

    await expect(
      methods["teams.save"]({ team: { id: "team-1", name: "Team 1", statuses: [] } }),
    ).rejects.toThrow("statuses must contain at least one status");

    expect(teamStore.transaction).not.toHaveBeenCalled();
  });

  it("rejects statuses without a done key for teams.update", async () => {
    const teamStore = createTeamStoreStub();
    const methods = teamMethods(teamStore as never);

    await expect(
      methods["teams.update"]({
        id: "team-1",
        statuses: [
          { key: "todo", label: "Todo", color: "#64748b" },
          { key: "in_progress", label: "In Progress", color: "#f59e0b" },
        ],
      }),
    ).rejects.toThrow('statuses must include a "done" status key');

    expect(teamStore.updateTeam).not.toHaveBeenCalled();
  });

  it("rejects statuses without a done key for teams.save", async () => {
    const teamStore = createTeamStoreStub();
    const methods = teamMethods(teamStore as never);

    await expect(
      methods["teams.save"]({
        team: {
          id: "team-1",
          name: "Team 1",
          statuses: [
            { key: "todo", label: "Todo", color: "#64748b" },
            { key: "in_progress", label: "In Progress", color: "#f59e0b" },
          ],
        },
      }),
    ).rejects.toThrow('statuses must include a "done" status key');

    expect(teamStore.transaction).not.toHaveBeenCalled();
  });

});
