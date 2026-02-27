import type { LanguageModel, ToolSet } from "ai";
import type { AgentConfig, TeamConfig, TaskStatusConfig } from "../config/agent-config.js";
import type { Config } from "../config.js";
import type { MemoryStore } from "../memory/store.js";
import type { EmbeddingProvider } from "../memory/embedding.js";
import type { ModelDef } from "../config/model-catalog.js";
import type { CodexReasoningEffort } from "../config/model-spec.js";
import { parseModelSpec } from "../config/model-spec.js";
import { getModel } from "./providers.js";
import { resolveModelDef } from "../config/model-catalog.js";

export interface WorkerDeps {
  memoryStore: MemoryStore | null;
  embeddingProvider: EmbeddingProvider | null;
  baseTools: ToolSet;
  config: Config;
}

export interface ResolvedAgent {
  agentConfig: AgentConfig;
  model: LanguageModel;
  modelDef: ModelDef;
  tools: ToolSet;
}

export interface ResolvedAgentById {
  role: "orchestrator" | "worker";
  resolved: ResolvedAgent;
}


/**
 * Holds agent configs for a single team.
 * The first config is the orchestrator, rest are workers.
 * `canDelegate` is auto-derived from team membership.
 */
export class AgentRegistry {
  private orchestratorConfig: AgentConfig;
  /** Workers keyed by name (human-readable, unique within team). */
  private workersByName: Map<string, AgentConfig>;
  private workerNames: string[];

  constructor(
    orchestrator: AgentConfig,
    workers: AgentConfig[],
    private deps: WorkerDeps,
  ) {
    this.orchestratorConfig = orchestrator;
    this.workersByName = new Map(workers.map((w) => [w.name, w]));
    this.workerNames = workers.map((w) => w.name);
  }

  getOrchestrator(): AgentConfig {
    return this.orchestratorConfig;
  }

  /** Resolve the orchestrator into a model + def, ready for per-session override. */
  resolveOrchestrator(): ResolvedAgent {
    return this.resolveConfig(this.orchestratorConfig);
  }

  getWorker(name: string): AgentConfig | undefined {
    return this.workersByName.get(name);
  }

  /** Return the list of worker names that the orchestrator can delegate to. */
  delegatableWorkers(): string[] {
    return this.workerNames;
  }

  /** Build an id→name map for all agents (orchestrator + workers). */
  buildIdToNameMap(): Map<string, string> {
    const map = new Map<string, string>();
    map.set(this.orchestratorConfig.id, this.orchestratorConfig.name);
    for (const w of this.workersByName.values()) {
      map.set(w.id, w.name);
    }
    return map;
  }

  /** Resolve a worker by name into a model + filtered tool set, ready for runLoop(). */
  resolveWorker(name: string): ResolvedAgent | null {
    const cfg = this.workersByName.get(name);
    return cfg ? this.resolveConfig(cfg) : null;
  }

  /** Resolve any team agent by stable ID (orchestrator or worker). */
  resolveAgentById(agentId: string): ResolvedAgentById | null {
    if (this.orchestratorConfig.id === agentId) {
      return { role: "orchestrator", resolved: this.resolveOrchestrator() };
    }

    for (const worker of this.workersByName.values()) {
      if (worker.id === agentId) {
        return { role: "worker", resolved: this.resolveConfig(worker) };
      }
    }
    return null;
  }

  private resolveConfig(cfg: AgentConfig): ResolvedAgent {
    const { provider, modelId, codexReasoningEffort } = parseModel(cfg.model);
    const model = getModel(provider, modelId, { codexReasoningEffort });
    const modelDef = resolveModelDef(modelId, cfg.contextWindow);
    const tools = filterTools(this.deps.baseTools, cfg.tools);
    return { agentConfig: cfg, model, modelDef, tools };
  }
}

export interface TeamAgentInfo {
  id: string;
  name: string;
  subscriptions: string[];
  concurrency: number;
}

/** Info returned by TeamRegistry.listTeams() for UI display. */
export interface TeamInfo {
  id: string;
  name: string;
  color: string;
  orchestratorId: string;
  orchestratorIdentity: string;
  orchestratorModel: string;
  workerCount: number;
  /** Worker agents with subscription info for the task board UI. */
  workers?: TeamAgentInfo[];
  /** Custom task statuses (undefined = defaults). */
  statuses?: TaskStatusConfig[];
}

/**
 * Wraps per-team AgentRegistry instances.
 * Provides team resolution and isolation boundaries.
 */
export class TeamRegistry {
  private teams: Map<string, { config: TeamConfig; registry: AgentRegistry }>;

  constructor(teams: TeamConfig[], deps: WorkerDeps) {
    this.teams = new Map(
      teams.map((t) => [
        t.id,
        {
          config: t,
          registry: new AgentRegistry(t.orchestrator, t.workers, deps),
        },
      ]),
    );
  }

  /** Find which team owns an orchestrator ID. */
  resolveTeam(orchestratorId: string): { teamId: string; registry: AgentRegistry } | null {
    for (const [teamId, { config, registry }] of this.teams) {
      if (config.orchestrator.id === orchestratorId) {
        return { teamId, registry };
      }
    }
    return null;
  }

  /** Get registry for a specific team by teamId. */
  getTeamRegistry(teamId: string): AgentRegistry | null {
    return this.teams.get(teamId)?.registry ?? null;
  }

  /** Get raw team config for a specific team by teamId. */
  getTeamConfig(teamId: string): TeamConfig | null {
    return this.teams.get(teamId)?.config ?? null;
  }

  /** All teams for UI picker. */
  listTeams(): TeamInfo[] {
    return [...this.teams.values()].map(({ config }) => ({
      id: config.id,
      name: config.name ?? config.id,
      color: config.color ?? "",
      orchestratorId: config.orchestrator.id,
      orchestratorIdentity: config.orchestrator.identity,
      orchestratorModel: parseModel(config.orchestrator.model).modelId,
      workerCount: config.workers.length,
    }));
  }

  /** True if any team has workers. */
  hasWorkers(): boolean {
    for (const { config } of this.teams.values()) {
      if (config.workers.length > 0) return true;
    }
    return false;
  }
}

/** Parse "provider:modelId" string. */
export function parseModel(raw: string): {
  provider: string;
  modelId: string;
  codexReasoningEffort?: CodexReasoningEffort;
} {
  const parsed = parseModelSpec(raw);
  return {
    provider: parsed.provider,
    modelId: parsed.modelId,
    codexReasoningEffort: parsed.codexReasoningEffort,
  };
}

/** Return only the tools whose names are in the allowlist, or all if allowlist is empty. */
function filterTools(base: ToolSet, allowlist: string[]): ToolSet {
  if (allowlist.length === 0) return { ...base };
  const filtered: ToolSet = {};
  for (const name of allowlist) {
    if (name in base) filtered[name] = base[name];
  }
  return filtered;
}
