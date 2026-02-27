import { describe, it, expect, vi } from "vitest";
import type { AgentConfig, TeamConfig } from "../config/agent-config.js";
import { DEFAULT_WORKER_TIMEOUT_S } from "../config/agent-config.js";
import type { ToolSet } from "ai";

// Mock external deps that agent-registry calls (getModel, resolveModelDef)
vi.mock("./providers.js", () => ({
  getModel: vi.fn((_provider: string, _modelId: string) => ({
    // Fake LanguageModel — just needs to exist
    specificationVersion: "v1",
    provider: _provider,
    modelId: _modelId,
  })),
}));

vi.mock("../config/model-catalog.js", () => ({
  resolveModelDef: vi.fn((_modelId: string, _ctxOverride?: number) => ({
    provider: "anthropic",
    modelId: _modelId,
    group: "Anthropic",
    contextWindow: 200_000,
  })),
}));

// Import after mocks
const { AgentRegistry, TeamRegistry } = await import("./agent-registry.js");

function makeOrchestrator(): AgentConfig {
  return {
    id: "main",
    name: "main",
    model: "anthropic:claude-sonnet-4-5",
    contextWindow: 0,
    maxSteps: 0,
    identity: "You are the orchestrator.",
    tools: [],
    timeout: DEFAULT_WORKER_TIMEOUT_S,
    subscriptions: [],
    concurrency: 1,
  };
}

function makeWorkers(): AgentConfig[] {
  return [
    {
      id: "researcher",
      name: "researcher",
      model: "anthropic:claude-haiku-4-5",
      contextWindow: 0,
      maxSteps: 0,
      identity: "You are a research specialist.",
      tools: ["web_fetch"],
      timeout: 60,
      subscriptions: [],
      concurrency: 1,
    },
    {
      id: "coder",
      name: "coder",
      model: "anthropic:claude-sonnet-4-5",
      contextWindow: 0,
      maxSteps: 0,
      identity: "You are a coding specialist.",
      tools: [],
      timeout: DEFAULT_WORKER_TIMEOUT_S,
      subscriptions: [],
      concurrency: 1,
    },
  ];
}

function makeBaseTools(): ToolSet {
  return {
    web_fetch: { description: "Fetch web" } as any,
    bash: { description: "Run bash" } as any,
    memory_save: { description: "Save memory" } as any,
  };
}

function makeDeps() {
  return {
    memoryStore: null,
    embeddingProvider: null,
    baseTools: makeBaseTools(),
    config: {} as any,
  };
}

describe("AgentRegistry", () => {
  it("getOrchestrator() returns the orchestrator config", () => {
    const registry = new AgentRegistry(makeOrchestrator(), makeWorkers(), makeDeps());

    const orch = registry.getOrchestrator();
    expect(orch).toBeDefined();
    expect(orch.id).toBe("main");
  });

  it("getWorker() returns worker by name, undefined for non-worker", () => {
    const registry = new AgentRegistry(makeOrchestrator(), makeWorkers(), makeDeps());

    expect(registry.getWorker("researcher")).toBeDefined();
    expect(registry.getWorker("researcher")!.name).toBe("researcher");

    // Non-existent
    expect(registry.getWorker("nonexistent")).toBeUndefined();

    // Orchestrator is not in workers map
    expect(registry.getWorker("main")).toBeUndefined();
  });

  it("delegatableWorkers() returns all worker names", () => {
    const registry = new AgentRegistry(makeOrchestrator(), makeWorkers(), makeDeps());

    const workers = registry.delegatableWorkers();
    expect(workers).toEqual(["researcher", "coder"]);
  });

  it("resolveWorker() filters tools by allowlist", () => {
    const registry = new AgentRegistry(makeOrchestrator(), makeWorkers(), makeDeps());

    // Researcher has tools: ["web_fetch"] — should only get web_fetch
    const researcher = registry.resolveWorker("researcher");
    expect(researcher).not.toBeNull();
    expect(Object.keys(researcher!.tools)).toEqual(["web_fetch"]);

    // Coder has tools: [] — should inherit all base tools
    const coder = registry.resolveWorker("coder");
    expect(coder).not.toBeNull();
    expect(Object.keys(coder!.tools).sort()).toEqual(["bash", "memory_save", "web_fetch"]);
  });

  it("resolveWorker() returns null for nonexistent", () => {
    const registry = new AgentRegistry(makeOrchestrator(), makeWorkers(), makeDeps());
    expect(registry.resolveWorker("nonexistent")).toBeNull();
  });

  it("resolveWorker() returns correct model info", () => {
    const registry = new AgentRegistry(makeOrchestrator(), makeWorkers(), makeDeps());

    const researcher = registry.resolveWorker("researcher");
    expect(researcher!.model).toBeDefined();
    expect(researcher!.agentConfig.model).toBe("anthropic:claude-haiku-4-5");
    expect(researcher!.modelDef).toBeDefined();
  });

  it("resolveOrchestrator() returns model + meta for the orchestrator", () => {
    const registry = new AgentRegistry(makeOrchestrator(), makeWorkers(), makeDeps());

    const resolved = registry.resolveOrchestrator();
    expect(resolved.agentConfig.id).toBe("main");
    expect(resolved.model).toBeDefined();
    expect(resolved.modelDef).toBeDefined();
  });

  it("resolveAgentById() resolves orchestrator and workers by stable id", () => {
    const registry = new AgentRegistry(makeOrchestrator(), makeWorkers(), makeDeps());

    const orchestrator = registry.resolveAgentById("main");
    expect(orchestrator).not.toBeNull();
    expect(orchestrator!.role).toBe("orchestrator");
    expect(orchestrator!.resolved.agentConfig.name).toBe("main");

    const worker = registry.resolveAgentById("researcher");
    expect(worker).not.toBeNull();
    expect(worker!.role).toBe("worker");
    expect(worker!.resolved.agentConfig.name).toBe("researcher");
  });

  it("resolveAgentById() returns null for unknown ids", () => {
    const registry = new AgentRegistry(makeOrchestrator(), makeWorkers(), makeDeps());
    expect(registry.resolveAgentById("missing-agent")).toBeNull();
  });
});

describe("TeamRegistry", () => {
  function makeTeams(): TeamConfig[] {
    return [
      {
        id: "research",
        name: "Research Team",
        orchestrator: {
          id: "lead-r",
          name: "lead-r",
          model: "anthropic:claude-sonnet-4-5",
          contextWindow: 0,
          maxSteps: 0,
          identity: "Research lead",
          tools: [],
          timeout: DEFAULT_WORKER_TIMEOUT_S,
          subscriptions: [],
          concurrency: 1,
        },
        workers: [
          {
            id: "searcher",
            name: "searcher",
            model: "anthropic:claude-haiku-4-5",
            contextWindow: 0,
            maxSteps: 0,
            identity: "Web searcher",
            tools: ["web_fetch"],
            timeout: 60,
            subscriptions: [],
            concurrency: 1,
          },
        ],
      },
      {
        id: "coding",
        name: "Coding Team",
        orchestrator: {
          id: "lead-c",
          name: "lead-c",
          model: "anthropic:claude-sonnet-4-5",
          contextWindow: 0,
          maxSteps: 0,
          identity: "Coding lead",
          tools: [],
          timeout: DEFAULT_WORKER_TIMEOUT_S,
          subscriptions: [],
          concurrency: 1,
        },
        workers: [
          {
            id: "frontend",
            name: "frontend",
            model: "anthropic:claude-sonnet-4-5",
            contextWindow: 0,
            maxSteps: 0,
            identity: "Frontend dev",
            tools: [],
            timeout: DEFAULT_WORKER_TIMEOUT_S,
            subscriptions: [],
            concurrency: 1,
          },
          {
            id: "backend",
            name: "backend",
            model: "anthropic:claude-sonnet-4-5",
            contextWindow: 0,
            maxSteps: 0,
            identity: "Backend dev",
            tools: [],
            timeout: DEFAULT_WORKER_TIMEOUT_S,
            subscriptions: [],
            concurrency: 1,
          },
        ],
      },
    ];
  }

  it("resolveTeam() finds team by orchestrator ID", () => {
    const teamReg = new TeamRegistry(makeTeams(), makeDeps());

    const result = teamReg.resolveTeam("lead-r");
    expect(result).not.toBeNull();
    expect(result!.teamId).toBe("research");

    const result2 = teamReg.resolveTeam("lead-c");
    expect(result2).not.toBeNull();
    expect(result2!.teamId).toBe("coding");
  });

  it("resolveTeam() returns null for unknown orchestrator", () => {
    const teamReg = new TeamRegistry(makeTeams(), makeDeps());
    expect(teamReg.resolveTeam("unknown")).toBeNull();
  });

  it("getTeamRegistry() returns registry by team ID", () => {
    const teamReg = new TeamRegistry(makeTeams(), makeDeps());

    const reg = teamReg.getTeamRegistry("research");
    expect(reg).not.toBeNull();
    expect(reg!.getOrchestrator().id).toBe("lead-r");
  });

  it("getTeamRegistry() returns null for unknown team", () => {
    const teamReg = new TeamRegistry(makeTeams(), makeDeps());
    expect(teamReg.getTeamRegistry("unknown")).toBeNull();
  });

  it("getTeamConfig() returns raw team config by team ID", () => {
    const teamReg = new TeamRegistry(makeTeams(), makeDeps());

    const team = teamReg.getTeamConfig("research");
    expect(team).not.toBeNull();
    expect(team!.id).toBe("research");
    expect(team!.name).toBe("Research Team");
  });

  it("getTeamConfig() returns null for unknown team", () => {
    const teamReg = new TeamRegistry(makeTeams(), makeDeps());
    expect(teamReg.getTeamConfig("unknown")).toBeNull();
  });

  it("listTeams() returns info for all teams", () => {
    const teamReg = new TeamRegistry(makeTeams(), makeDeps());

    const list = teamReg.listTeams();
    expect(list).toHaveLength(2);
    expect(list[0]).toEqual({
      id: "research",
      name: "Research Team",
      color: "",
      orchestratorId: "lead-r",
      orchestratorIdentity: "Research lead",
      orchestratorModel: "claude-sonnet-4-5",
      workerCount: 1,
    });
    expect(list[1].id).toBe("coding");
    expect(list[1].workerCount).toBe(2);
  });

  it("hasWorkers() returns true when any team has workers", () => {
    const teamReg = new TeamRegistry(makeTeams(), makeDeps());
    expect(teamReg.hasWorkers()).toBe(true);
  });

  it("hasWorkers() returns false when no team has workers", () => {
    const teams: TeamConfig[] = [{
      id: "solo",
      orchestrator: {
        id: "main",
        name: "main",
        model: "anthropic:claude-sonnet-4-5",
        contextWindow: 0,
        maxSteps: 0,
        identity: "Solo",
        tools: [],
        timeout: DEFAULT_WORKER_TIMEOUT_S,
        subscriptions: [],
        concurrency: 1,
      },
      workers: [],
    }];
    const teamReg = new TeamRegistry(teams, makeDeps());
    expect(teamReg.hasWorkers()).toBe(false);
  });

  it("team isolation: team A workers not visible in team B", () => {
    const teamReg = new TeamRegistry(makeTeams(), makeDeps());

    const researchReg = teamReg.getTeamRegistry("research")!;
    const codingReg = teamReg.getTeamRegistry("coding")!;

    // Research team only sees its own worker
    expect(researchReg.delegatableWorkers()).toEqual(["searcher"]);
    expect(researchReg.getWorker("frontend")).toBeUndefined();

    // Coding team only sees its own workers
    expect(codingReg.delegatableWorkers()).toEqual(["frontend", "backend"]);
    expect(codingReg.getWorker("searcher")).toBeUndefined();
  });
});
