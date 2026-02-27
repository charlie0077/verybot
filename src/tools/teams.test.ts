import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { TeamStore } from "../teams/store.js";
import { DEFAULT_TEAM_ID } from "../config/agent-config.js";
import { createScopedWorkerManagementTools, createTeamManagementTools } from "./teams.js";

let tmpDir: string;
let dbPath: string;
let store: TeamStore;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "team-tools-test-"));
  dbPath = join(tmpDir, "test.db");
  store = await TeamStore.create(dbPath);
  store.createTeam({ id: DEFAULT_TEAM_ID, name: "Default Team" });
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("createTeamManagementTools — team status CRUD", () => {
  it("hides the internal default team from team_list output", async () => {
    const tools = createTeamManagementTools(store, DEFAULT_TEAM_ID);
    const teamList = tools.team_list as unknown as {
      execute: () => Promise<string>;
    };

    const result = await teamList.execute();

    expect(result).toBe("No teams found.");
  });

  it("creates a new team via team_create and lists it", async () => {
    const tools = createTeamManagementTools(store, DEFAULT_TEAM_ID);
    const teamCreate = tools.team_create as unknown as {
      execute: (input: { name: string; teamId?: string; color?: string }) => Promise<string>;
    };
    const teamList = tools.team_list as unknown as {
      execute: () => Promise<string>;
    };

    const createResult = await teamCreate.execute({
      name: "eng",
      teamId: "eng",
      color: "#ef4444",
    });
    const listResult = await teamList.execute();

    expect(createResult).toContain('Team created: "eng" (id: eng)');
    expect(listResult).toContain("**eng** (id: eng, color: #ef4444)");
    expect(listResult).not.toContain("(id: default");
  });

  it("lists default effective statuses when custom statuses are unset", async () => {
    const tools = createTeamManagementTools(store, DEFAULT_TEAM_ID);
    const teamStatusList = tools.team_status_list as unknown as {
      execute: (input: { teamId?: string }) => Promise<string>;
    };

    const result = await teamStatusList.execute({});

    expect(result).toContain("source: default");
    expect(result).toContain("- backlog — Backlog (#71717a)");
    expect(result).toContain("- done — Done (#22c55e)");
  });

  it("adds a status and persists custom statuses on the team", async () => {
    const tools = createTeamManagementTools(store, DEFAULT_TEAM_ID);
    const teamStatusAdd = tools.team_status_add as unknown as {
      execute: (input: { key: string; label: string; color: string }) => Promise<string>;
    };

    const result = await teamStatusAdd.execute({
      key: "qa_review",
      label: "QA Review",
      color: "#3b82f6",
    });

    expect(result).toContain("Task status added");
    const statuses = store.getTeamById(DEFAULT_TEAM_ID)?.statuses ?? [];
    expect(statuses.some((status) => status.key === "qa_review")).toBe(true);
    expect(statuses.some((status) => status.key === "done")).toBe(true);
  });

  it("gets and updates a status by key", async () => {
    const tools = createTeamManagementTools(store, DEFAULT_TEAM_ID);
    const teamStatusAdd = tools.team_status_add as unknown as {
      execute: (input: { key: string; label: string; color: string }) => Promise<string>;
    };
    const teamStatusGet = tools.team_status_get as unknown as {
      execute: (input: { key: string }) => Promise<string>;
    };
    const teamStatusUpdate = tools.team_status_update as unknown as {
      execute: (input: { key: string; label?: string; color?: string }) => Promise<string>;
    };

    await teamStatusAdd.execute({
      key: "qa_review",
      label: "QA Review",
      color: "#3b82f6",
    });

    const getResult = await teamStatusGet.execute({ key: "qa_review" });
    expect(getResult).toContain("- qa_review — QA Review (#3b82f6)");

    const updateResult = await teamStatusUpdate.execute({
      key: "qa_review",
      label: "Quality Review",
      color: "#1d4ed8",
    });
    expect(updateResult).toContain("Task status updated");

    const statuses = store.getTeamById(DEFAULT_TEAM_ID)?.statuses ?? [];
    const updated = statuses.find((status) => status.key === "qa_review");
    expect(updated).toEqual({ key: "qa_review", label: "Quality Review", color: "#1d4ed8" });
  });

  it("blocks deletion of required done status", async () => {
    const tools = createTeamManagementTools(store, DEFAULT_TEAM_ID);
    const teamStatusDelete = tools.team_status_delete as unknown as {
      execute: (input: { key: string }) => Promise<string>;
    };

    const result = await teamStatusDelete.execute({ key: "done" });

    expect(result).toBe("Cannot delete required status: done");
    expect(store.getTeamById(DEFAULT_TEAM_ID)?.statuses).toBeUndefined();
  });

  it("deletes a custom status by key", async () => {
    const tools = createTeamManagementTools(store, DEFAULT_TEAM_ID);
    const teamStatusAdd = tools.team_status_add as unknown as {
      execute: (input: { key: string; label: string; color: string }) => Promise<string>;
    };
    const teamStatusDelete = tools.team_status_delete as unknown as {
      execute: (input: { key: string }) => Promise<string>;
    };

    await teamStatusAdd.execute({
      key: "qa_review",
      label: "QA Review",
      color: "#3b82f6",
    });
    const result = await teamStatusDelete.execute({ key: "qa_review" });

    expect(result).toContain("Task status deleted");
    const statuses = store.getTeamById(DEFAULT_TEAM_ID)?.statuses ?? [];
    expect(statuses.some((status) => status.key === "qa_review")).toBe(false);
    expect(statuses.some((status) => status.key === "done")).toBe(true);
  });
});

describe("createScopedWorkerManagementTools", () => {
  it("allows worker CRUD only inside the scoped team", async () => {
    const ops = store.createTeam({ id: "ops", name: "Ops" });
    const sales = store.createTeam({ id: "sales", name: "Sales" });
    const salesWorker = store.createAgent(sales.id, {
      name: "Sales Agent",
      role: "worker",
      model: "openai:gpt-5",
    });

    const tools = createScopedWorkerManagementTools(store, ops.id);
    const workerCreate = tools.worker_create as unknown as {
      execute: (input: { teamId?: string; name: string; model: string }) => Promise<string>;
    };
    const workerUpdate = tools.worker_update as unknown as {
      execute: (input: { id: string; name?: string }) => Promise<string>;
    };
    const workerDelete = tools.worker_delete as unknown as {
      execute: (input: { id: string }) => Promise<string>;
    };

    const createResult = await workerCreate.execute({
      name: "Ops Agent",
      model: "openai:gpt-5",
    });
    expect(createResult).toContain('Worker created: "Ops Agent"');

    const opsWorker = store.listAgentsByTeam(ops.id).find((agent) => agent.name === "Ops Agent");
    expect(opsWorker).toBeDefined();

    const updateResult = await workerUpdate.execute({ id: opsWorker!.id, name: "Ops Renamed Agent" });
    expect(updateResult).toContain('Worker updated: "Ops Renamed Agent"');

    const crossTeamUpdateResult = await workerUpdate.execute({ id: salesWorker.id, name: "Should Not Update" });
    expect(crossTeamUpdateResult).toBe(`Agent not found: ${salesWorker.id}`);
    expect(store.getAgentById(salesWorker.id)?.name).toBe("Sales Agent");

    const crossTeamDeleteResult = await workerDelete.execute({ id: salesWorker.id });
    expect(crossTeamDeleteResult).toBe(`Agent not found: ${salesWorker.id}`);
    expect(store.getAgentById(salesWorker.id)).not.toBeNull();

    const deleteResult = await workerDelete.execute({ id: opsWorker!.id });
    expect(deleteResult).toBe(`Worker deleted: ${opsWorker!.id}`);
    expect(store.getAgentById(opsWorker!.id)).toBeNull();
  });

  it("rejects explicit teamId outside the scoped team on worker_create", async () => {
    const ops = store.createTeam({ id: "ops", name: "Ops" });
    const sales = store.createTeam({ id: "sales", name: "Sales" });
    const tools = createScopedWorkerManagementTools(store, ops.id);
    const workerCreate = tools.worker_create as unknown as {
      execute: (input: { teamId?: string; name: string; model: string }) => Promise<string>;
    };

    const result = await workerCreate.execute({
      teamId: sales.id,
      name: "Blocked Agent",
      model: "openai:gpt-5",
    });

    expect(result).toBe(`This tool is scoped to team: ${ops.id}`);
  });
});
