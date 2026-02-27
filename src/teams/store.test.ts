import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { TeamStore } from "./store.js";
import { PromptTemplateStore } from "../prompt-templates/store.js";
import { TaskStore } from "../tasks/store.js";
import { DEFAULT_TEAM_ID } from "../config/agent-config.js";

let store: TeamStore;
let promptStore: PromptTemplateStore;
let tmpDir: string;
let dbPath: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "team-store-test-"));
  dbPath = join(tmpDir, "test.db");
  // Create PromptTemplateStore first (FK ordering — prompt_templates table must exist)
  promptStore = await PromptTemplateStore.create(dbPath);
  store = await TeamStore.create(dbPath);
});

afterEach(() => {
  store.close();
  promptStore.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("TeamStore — teams", () => {
  it("creates and retrieves a team", () => {
    const team = store.createTeam({ name: "Research" });
    expect(team.name).toBe("Research");
    expect(team.id).toBeTruthy();

    const found = store.getTeamById(team.id);
    expect(found).toEqual(team);
  });

  it("lists teams in creation order", () => {
    store.createTeam({ name: "Alpha" });
    store.createTeam({ name: "Beta" });
    const teams = store.listTeams();
    expect(teams.map((t) => t.name)).toEqual(["Alpha", "Beta"]);
  });

  it("enforces unique team names", () => {
    store.createTeam({ name: "Unique" });
    expect(() => store.createTeam({ name: "Unique" })).toThrow(/already exists/);
  });

  it("renames a team", () => {
    const team = store.createTeam({ name: "Old" });
    const updated = store.updateTeam(team.id, { name: "New" });
    expect(updated?.name).toBe("New");
    expect(store.getTeamById(team.id)?.name).toBe("New");
  });

  it("deletes a team", () => {
    const team = store.createTeam({ name: "ToDelete" });
    expect(store.deleteTeam(team.id)).toBe(true);
    expect(store.getTeamById(team.id)).toBeNull();
  });

  it("returns false when deleting non-existent team", () => {
    expect(store.deleteTeam("nonexistent")).toBe(false);
  });

  it("returns null for non-existent team", () => {
    expect(store.getTeamById("nope")).toBeNull();
    expect(store.getTeamByName("nope")).toBeNull();
  });

  it("does not auto-create teams on update when no teams exist", () => {
    const updated = store.updateTeam(DEFAULT_TEAM_ID, { name: "claude-code-flox" });
    expect(updated).toBeNull();
    expect(store.listTeams()).toEqual([]);
  });

  it("does not auto-create non-default teams when no teams exist", () => {
    expect(() => store.createAgent("ops", { name: "worker-a", role: "worker", model: "m" }))
      .toThrow("Team not found: ops");
    expect(store.getTeamById(DEFAULT_TEAM_ID)).toBeNull();
    expect(store.getTeamById("ops")).toBeNull();
  });

  it("ensureTeamWhenEmpty bootstraps default when store is empty", () => {
    const bootstrapped = store.ensureTeamWhenEmpty();
    expect(bootstrapped?.id).toBe(DEFAULT_TEAM_ID);
    expect(bootstrapped?.name).toBe("Default");

    const second = store.ensureTeamWhenEmpty();
    expect(second?.id).toBe(DEFAULT_TEAM_ID);
    expect(store.listTeams().map((team) => team.id)).toEqual([DEFAULT_TEAM_ID]);
  });

  it("ensureTeamWhenEmpty bootstraps default even when other teams already exist", () => {
    const other = store.createTeam({ name: "Ops" });

    const bootstrapped = store.ensureTeamWhenEmpty();

    expect(bootstrapped?.id).toBe(DEFAULT_TEAM_ID);
    expect(store.getTeamById(DEFAULT_TEAM_ID)).not.toBeNull();
    expect(store.getTeamById(other.id)).not.toBeNull();
  });

  it("ensureTeamWhenEmpty is id-based and does not auto-resolve name collisions", () => {
    store.createTeam({ name: "Default" });

    expect(() => store.ensureTeamWhenEmpty()).toThrow('A team named "Default" already exists');
    expect(store.getTeamById(DEFAULT_TEAM_ID)).toBeNull();
  });

  it("rejects names exceeding max length", () => {
    const longName = "a".repeat(129);
    expect(() => store.createTeam({ name: longName })).toThrow(/maximum length/);
  });

  it("creates a team with a color", () => {
    const team = store.createTeam({ name: "Colored", color: "#ef4444" });
    expect(team.color).toBe("#ef4444");
    expect(store.getTeamById(team.id)?.color).toBe("#ef4444");
  });

  it("defaults color to empty string", () => {
    const team = store.createTeam({ name: "NoColor" });
    expect(team.color).toBe("");
  });

  it("updates a team color", () => {
    const team = store.createTeam({ name: "T", color: "#ef4444" });
    const updated = store.updateTeam(team.id, { color: "#3b82f6" });
    expect(updated?.color).toBe("#3b82f6");
    expect(updated?.name).toBe("T");
  });

  it("rejects invalid color format", () => {
    expect(() => store.createTeam({ name: "Bad", color: "red" })).toThrow(/valid hex color/);
    expect(() => store.createTeam({ name: "Bad2", color: "#gg0000" })).toThrow(/valid hex color/);
  });

  it("rejects team statuses that do not include done on create", () => {
    expect(() => store.createTeam({
      name: "Invalid Status Team",
      statuses: [
        { key: "todo", label: "Todo", color: "#64748b" },
        { key: "in_progress", label: "In Progress", color: "#f59e0b" },
      ],
    })).toThrow('statuses must include a "done" status key');
  });

  it("rejects team statuses that do not include done on update", () => {
    const team = store.createTeam({ name: "Status Team" });
    expect(() => store.updateTeam(team.id, {
      statuses: [
        { key: "todo", label: "Todo", color: "#64748b" },
      ],
    })).toThrow('statuses must include a "done" status key');
  });
});

describe("TeamStore — claimable tasks", () => {
  it("only matches tasks with agents from the same team", async () => {
    const taskStore = await TaskStore.create(dbPath);
    try {
      const teamA = store.createTeam({ name: "Team A" });
      const teamB = store.createTeam({ name: "Team B" });

      const workerA = store.createAgent(teamA.id, {
        name: "worker-a",
        role: "worker",
        model: "m",
        subscriptions: ["todo"],
      });
      const workerB = store.createAgent(teamB.id, {
        name: "worker-b",
        role: "worker",
        model: "m",
        subscriptions: ["todo"],
      });

      const taskA = taskStore.create({ title: "task-a", teamId: teamA.id, status: "todo" });
      const taskB = taskStore.create({ title: "task-b", teamId: teamB.id, status: "todo" });

      const candidates = store.findClaimableTasks(10);

      const byTask = new Map(candidates.map((candidate) => [candidate.taskId, candidate.agentId]));
      expect(byTask.get(taskA.id)).toBe(workerA.id);
      expect(byTask.get(taskB.id)).toBe(workerB.id);
    } finally {
      taskStore.close();
    }
  });

  it("does not return candidates for agents already at claim concurrency", async () => {
    const taskStore = await TaskStore.create(dbPath);
    try {
      const team = store.createTeam({ name: "Team C" });
      const worker = store.createAgent(team.id, {
        name: "worker-c",
        role: "worker",
        model: "m",
        subscriptions: ["todo"],
        concurrency: 2,
      });

      const taskOne = taskStore.create({ title: "task-1", teamId: team.id, status: "todo" });
      const taskTwo = taskStore.create({ title: "task-2", teamId: team.id, status: "todo" });
      const taskThree = taskStore.create({ title: "task-3", teamId: team.id, status: "todo" });

      taskStore.claimTaskById(taskOne.id, worker.id);
      taskStore.claimTaskById(taskTwo.id, worker.id);

      const atLimitCandidates = store
        .findClaimableTasks(10)
        .filter((candidate) => candidate.agentId === worker.id);
      expect(atLimitCandidates.some((candidate) => candidate.taskId === taskThree.id)).toBe(false);

      taskStore.releaseTaskIfClaimedBy(taskOne.id, worker.id);

      const belowLimitCandidates = store
        .findClaimableTasks(10)
        .filter((candidate) => candidate.agentId === worker.id);
      expect(belowLimitCandidates.some((candidate) => candidate.taskId === taskThree.id)).toBe(true);
    } finally {
      taskStore.close();
    }
  });

  it("skips tasks already finalized by the same agent for the current task version", async () => {
    const taskStore = await TaskStore.create(dbPath);
    try {
      const team = store.createTeam({ name: "Team D" });
      const worker = store.createAgent(team.id, {
        name: "worker-d",
        role: "worker",
        model: "m",
        subscriptions: ["todo"],
      });
      const task = taskStore.create({ title: "task-d", teamId: team.id, status: "todo" });

      taskStore.claimTaskById(task.id, worker.id);
      expect(taskStore.finalizeClaimedTaskRun(task.id, worker.id)).toBe(true);

      const candidates = store.findClaimableTasks(10);
      expect(candidates.some((candidate) => candidate.taskId === task.id && candidate.agentId === worker.id)).toBe(false);
    } finally {
      taskStore.close();
    }
  });

  it("re-enables finalized tasks for the same agent after the task is updated", async () => {
    const taskStore = await TaskStore.create(dbPath);
    try {
      const team = store.createTeam({ name: "Team E" });
      const worker = store.createAgent(team.id, {
        name: "worker-e",
        role: "worker",
        model: "m",
        subscriptions: ["todo"],
      });
      const task = taskStore.create({ title: "task-e", teamId: team.id, status: "todo" });
      const TIMESTAMP_TICK_DELAY_MS = 1;

      taskStore.claimTaskById(task.id, worker.id);
      expect(taskStore.finalizeClaimedTaskRun(task.id, worker.id)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, TIMESTAMP_TICK_DELAY_MS));
      expect(taskStore.update(task.id, { description: "updated by user" }, { updatedBy: "user" })).not.toBeNull();

      const candidates = store.findClaimableTasks(10);
      expect(candidates.some((candidate) => candidate.taskId === task.id && candidate.agentId === worker.id)).toBe(true);
    } finally {
      taskStore.close();
    }
  });

  it("skips tasks marked as needsHumanReview", async () => {
    const taskStore = await TaskStore.create(dbPath);
    try {
      const team = store.createTeam({ name: "Team Human Review" });
      const worker = store.createAgent(team.id, {
        name: "worker-human",
        role: "worker",
        model: "m",
        subscriptions: ["todo"],
      });
      const waitingTask = taskStore.create({
        title: "Waiting on human",
        teamId: team.id,
        status: "todo",
        needsHumanReview: true,
      });
      const normalTask = taskStore.create({
        title: "Normal",
        teamId: team.id,
        status: "todo",
      });

      const candidates = store.findClaimableTasks(10);
      expect(candidates.some((candidate) => candidate.taskId === waitingTask.id && candidate.agentId === worker.id)).toBe(false);
      expect(candidates.some((candidate) => candidate.taskId === normalTask.id && candidate.agentId === worker.id)).toBe(true);
    } finally {
      taskStore.close();
    }
  });
});

describe("TeamStore — agents", () => {
  let teamId: string;

  beforeEach(() => {
    teamId = store.createTeam({ name: "TestTeam" }).id;
  });

  it("creates an orchestrator and a worker", () => {
    const orch = store.createAgent(teamId, {
      name: "lead", role: "orchestrator", model: "anthropic:claude-sonnet-4-5",
    });
    expect(orch.role).toBe("orchestrator");

    const worker = store.createAgent(teamId, {
      name: "coder", role: "worker", model: "anthropic:claude-haiku-4-5",
      identity: "You write code.", tools: ["bash"],
    });
    expect(worker.role).toBe("worker");
    expect(worker.tools).toEqual(["bash"]);

    const agents = store.listAgentsByTeam(teamId);
    expect(agents).toHaveLength(2);
  });

  it("prevents multiple orchestrators per team", () => {
    store.createAgent(teamId, { name: "lead", role: "orchestrator", model: "m" });
    expect(() =>
      store.createAgent(teamId, { name: "lead2", role: "orchestrator", model: "m" }),
    ).toThrow(/already has an orchestrator/);
  });

  it("enforces unique agent names within a team", () => {
    store.createAgent(teamId, { name: "coder", role: "worker", model: "m" });
    expect(() =>
      store.createAgent(teamId, { name: "coder", role: "worker", model: "m" }),
    ).toThrow(/already exists/);
  });

  it("allows same agent name in different teams", () => {
    const team2 = store.createTeam({ name: "Team2" }).id;
    store.createAgent(teamId, { name: "coder", role: "worker", model: "m" });
    const agent2 = store.createAgent(team2, { name: "coder", role: "worker", model: "m" });
    expect(agent2.name).toBe("coder");
  });

  it("rejects agent for non-existent team", () => {
    expect(() =>
      store.createAgent("nope", { name: "x", role: "worker", model: "m" }),
    ).toThrow(/Team not found/);
  });

  it("updates an agent", () => {
    const agent = store.createAgent(teamId, { name: "coder", role: "worker", model: "m" });
    const updated = store.updateAgent(agent.id, { name: "senior-coder", identity: "Senior dev" });
    expect(updated?.name).toBe("senior-coder");
    expect(updated?.identity).toBe("Senior dev");
  });

  it("prevents deleting an orchestrator", () => {
    const orch = store.createAgent(teamId, { name: "lead", role: "orchestrator", model: "m" });
    expect(() => store.deleteAgent(orch.id)).toThrow(/Cannot delete.*orchestrator/);
  });

  it("deletes a worker", () => {
    const worker = store.createAgent(teamId, { name: "coder", role: "worker", model: "m" });
    expect(store.deleteAgent(worker.id)).toBe(true);
    expect(store.getAgentById(worker.id)).toBeNull();
  });

  it("cascades agent deletion when team is deleted", () => {
    const agent = store.createAgent(teamId, { name: "coder", role: "worker", model: "m" });
    store.deleteTeam(teamId);
    expect(store.getAgentById(agent.id)).toBeNull();
  });

  it("rejects names exceeding max length", () => {
    const longName = "a".repeat(129);
    expect(() =>
      store.createAgent(teamId, { name: longName, role: "worker", model: "m" }),
    ).toThrow(/maximum length/);
  });

  it("rejects identity exceeding max length", () => {
    const longIdentity = "a".repeat(10_001);
    expect(() =>
      store.createAgent(teamId, { name: "x", role: "worker", model: "m", identity: longIdentity }),
    ).toThrow(/maximum length/);
  });
});

describe("TeamStore — toTeamConfigs", () => {
  it("returns empty array when no teams exist", () => {
    expect(store.toTeamConfigs()).toEqual([]);
  });

  it("excludes default team from TeamConfig output", () => {
    store.createTeam({ id: DEFAULT_TEAM_ID, name: "Default" });
    const team = store.createTeam({ name: "Ops" });
    store.createAgent(team.id, {
      name: "lead",
      role: "orchestrator",
      model: "anthropic:claude-sonnet-4-5",
    });

    const configs = store.toTeamConfigs();

    expect(configs).toHaveLength(1);
    expect(configs[0].id).toBe(team.id);
  });

  it("converts teams with agents to TeamConfig format", () => {
    const team = store.createTeam({ name: "Research" });
    store.createAgent(team.id, {
      name: "lead", role: "orchestrator", model: "anthropic:claude-sonnet-4-5",
      identity: "You lead research.",
    });
    store.createAgent(team.id, {
      name: "searcher", role: "worker", model: "anthropic:claude-haiku-4-5",
      identity: "You search the web.", tools: ["web_fetch"],
    });

    const configs = store.toTeamConfigs();
    expect(configs).toHaveLength(1);
    expect(configs[0].name).toBe("Research");
    expect(configs[0].orchestrator.name).toBe("lead");
    expect(configs[0].orchestrator.identity).toBe("You lead research.");
    expect(configs[0].workers).toHaveLength(1);
    expect(configs[0].workers[0].name).toBe("searcher");
    expect(configs[0].workers[0].tools).toEqual(["web_fetch"]);
  });

  it("provides fallback orchestrator when team has no orchestrator agent", () => {
    const team = store.createTeam({ name: "Bare" });
    const configs = store.toTeamConfigs();
    expect(configs).toHaveLength(1);
    expect(configs[0].id).toBe(team.id);
    expect(configs[0].orchestrator.id).toBe("main");
    expect(configs[0].orchestrator.name).toBe("main");
    expect(configs[0].workers).toEqual([]);
  });
});

describe("TeamStore — template integration", () => {
  let teamId: string;

  beforeEach(() => {
    teamId = store.createTeam({ name: "TemplateTeam" }).id;
  });

  it("creates an agent with a templateId", () => {
    const tpl = promptStore.createPromptTemplate({
      name: "Worker Prompt",
      role: "worker",
      content: "You are an expert coder.",
    });
    const agent = store.createAgent(teamId, {
      name: "coder",
      role: "worker",
      model: "m",
      templateId: tpl.id,
    });
    expect(agent.templateId).toBe(tpl.id);
    expect(store.getAgentById(agent.id)?.templateId).toBe(tpl.id);
  });

  it("defaults templateId to null", () => {
    const agent = store.createAgent(teamId, {
      name: "plain",
      role: "worker",
      model: "m",
      identity: "Direct identity",
    });
    expect(agent.templateId).toBeNull();
  });

  it("updates templateId on an agent", () => {
    const agent = store.createAgent(teamId, {
      name: "coder",
      role: "worker",
      model: "m",
    });
    const tpl = promptStore.createPromptTemplate({
      name: "Link Later",
      role: "worker",
      content: "Linked content.",
    });
    const updated = store.updateAgent(agent.id, { templateId: tpl.id });
    expect(updated?.templateId).toBe(tpl.id);
  });

  it("clears templateId by setting to null (detach)", () => {
    const tpl = promptStore.createPromptTemplate({
      name: "Detachable",
      role: "worker",
      content: "Will detach.",
    });
    const agent = store.createAgent(teamId, {
      name: "coder",
      role: "worker",
      model: "m",
      templateId: tpl.id,
    });
    const updated = store.updateAgent(agent.id, { templateId: null, identity: "Detached identity" });
    expect(updated?.templateId).toBeNull();
    expect(updated?.identity).toBe("Detached identity");
  });

  it("resolves identity from linked template in toTeamConfigs", () => {
    const tpl = promptStore.createPromptTemplate({
      name: "Resolved Prompt",
      role: "worker",
      content: "Identity from template.",
    });
    store.createAgent(teamId, {
      name: "lead",
      role: "orchestrator",
      model: "m",
      identity: "Direct orchestrator identity.",
    });
    store.createAgent(teamId, {
      name: "coder",
      role: "worker",
      model: "m",
      identity: "This should be overridden.",
      templateId: tpl.id,
    });

    const configs = store.toTeamConfigs();
    const team = configs.find((c) => c.id === teamId)!;
    // Orchestrator uses direct identity (no template)
    expect(team.orchestrator.identity).toBe("Direct orchestrator identity.");
    // Worker uses template content instead of raw identity
    expect(team.workers[0].identity).toBe("Identity from template.");
    expect(team.workers[0].templateId).toBe(tpl.id);
  });

  it("resolves identity from linked template in getRuntimeAgentById", () => {
    store.updateTeam(teamId, {
      workspace: "/workspace/mvp",
      variables: { product: "openclaw" },
    });
    const tpl = promptStore.createPromptTemplate({
      name: "Runtime Prompt",
      role: "worker",
      content: "Template for {{teamName}} at {{workspace}} / {{product}}.",
    });
    const agent = store.createAgent(teamId, {
      name: "coder",
      role: "worker",
      model: "m",
      identity: "Raw identity should not be used.",
      templateId: tpl.id,
    });

    // Raw store lookup remains unchanged for CRUD/update flows.
    expect(store.getAgentById(agent.id)?.identity).toBe("Raw identity should not be used.");

    const runtimeAgent = store.getRuntimeAgentById(agent.id);
    expect(runtimeAgent?.identity).toBe("Template for TemplateTeam at /workspace/mvp / openclaw.");
    expect(runtimeAgent?.templateId).toBe(tpl.id);
  });

  it("uses raw identity when no template is linked", () => {
    store.createAgent(teamId, {
      name: "lead",
      role: "orchestrator",
      model: "m",
      identity: "I am the leader.",
    });

    const configs = store.toTeamConfigs();
    const team = configs.find((c) => c.id === teamId)!;
    expect(team.orchestrator.identity).toBe("I am the leader.");
    expect(team.orchestrator.templateId).toBeNull();
  });

  it("gracefully handles deleted template (ON DELETE SET NULL)", () => {
    const tpl = promptStore.createPromptTemplate({
      name: "Ephemeral",
      role: "worker",
      content: "Will be deleted.",
    });
    store.createAgent(teamId, {
      name: "coder",
      role: "worker",
      model: "m",
      identity: "Fallback identity.",
      templateId: tpl.id,
    });

    // Delete the template — FK ON DELETE SET NULL should null the agent's template_id
    promptStore.deletePromptTemplate(tpl.id);

    const agent = store.getAgentById(
      store.listAgentsByTeam(teamId).find((a) => a.name === "coder")!.id,
    )!;
    expect(agent.templateId).toBeNull();

    // toTeamConfigs should fall back to raw identity
    store.createAgent(teamId, {
      name: "lead",
      role: "orchestrator",
      model: "m",
    });
    const configs = store.toTeamConfigs();
    const team = configs.find((c) => c.id === teamId)!;
    const worker = team.workers.find((w) => w.name === "coder")!;
    expect(worker.identity).toBe("Fallback identity.");
    expect(worker.templateId).toBeNull();
  });

  it("rejects agent creation with non-existent templateId (FK constraint)", () => {
    expect(() =>
      store.createAgent(teamId, {
        name: "broken",
        role: "worker",
        model: "m",
        templateId: "nonexistent-template-id",
      }),
    ).toThrow();
  });
});
