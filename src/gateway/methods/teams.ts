import { emit } from "../../events.js";
import type { TeamStore } from "../../teams/store.js";
import { MAX_NAME_LENGTH, MAX_IDENTITY_LENGTH, MAX_MODEL_LENGTH, HEX_COLOR_RE } from "../../teams/store.js";
import { validateStatusConfigs } from "../../teams/status-config.js";
import type { TeamConfig, AgentConfig, TaskStatusConfig } from "../../config/agent-config.js";
import { DEFAULT_TEAM_ID, DEFAULT_WORKER_TIMEOUT_S } from "../../config/agent-config.js";
import type { MemoryStore } from "../../memory/store.js";
import type { EmbeddingProvider } from "../../memory/embedding.js";
import { searchMemory } from "../../memory/search.js";
import { saveExplicitMemory } from "../../memory/explicit.js";
import { logger } from "../../logger.js";

const VALID_ROLES = new Set(["orchestrator", "worker"]);
const MAX_PAGE_SIZE = 200;

export function teamMethods(
  teamStore: TeamStore,
  memoryStore?: MemoryStore | null,
  embeddingProvider?: EmbeddingProvider | null,
) {
  return {
    /** List all teams with their agents. */
    "teams.list": async () => {
      const teams = teamStore.listTeams();
      const result = teams.map((team) => ({
        ...team,
        agents: teamStore.listAgentsByTeam(team.id),
      }));
      return { teams: result };
    },

    /** Return teams in the TeamConfig[] format used by the UI. */
    "teams.configs": async () => {
      return { teams: teamStore.toTeamConfigs() };
    },

    /**
     * Save a single team (create or update) including its agents.
     * Accepts a full TeamConfig; handles agent diff internally.
     */
    "teams.save": async (params: unknown) => {
      const { team } = (params ?? {}) as { team?: TeamConfig };
      if (!team || typeof team !== "object") throw new Error("team object is required");
      validateTeamConfig(team);
      teamStore.transaction(() => saveTeam(teamStore, team));
      emit("teamChange", { action: "saved", teamId: team.id });
      return { teams: teamStore.toTeamConfigs() };
    },

    /** Create a new team. */
    "teams.create": async (params: unknown) => {
      const { name, color } = (params ?? {}) as { name?: string; color?: string };
      if (!name || typeof name !== "string") throw new Error("name is required");
      const trimmed = name.trim();
      if (trimmed.length === 0) throw new Error("name cannot be empty");
      if (trimmed.length > MAX_NAME_LENGTH) throw new Error(`name exceeds maximum length of ${MAX_NAME_LENGTH}`);
      if (typeof color === "string" && color !== "" && !HEX_COLOR_RE.test(color)) throw new Error("color must be a valid hex color (e.g. #ef4444)");
      const team = teamStore.createTeam({ name: trimmed, color: typeof color === "string" ? color : undefined });
      emit("teamChange", { action: "created", team });
      return { team };
    },

    /** Update a team (rename / recolor / workspace / variables / statuses). */
    "teams.update": async (params: unknown) => {
      const p = (params ?? {}) as Record<string, unknown>;
      const id = p.id as string | undefined;
      const name = p.name as string | undefined;
      const color = p.color as string | undefined;
      const workspace = p.workspace as string | undefined;
      const variables = p.variables as Record<string, string> | undefined;
      const statuses = p.statuses as TaskStatusConfig[] | undefined;
      if (!id || typeof id !== "string") throw new Error("id is required");
      if (name !== undefined) {
        if (typeof name !== "string" || name.trim().length === 0) throw new Error("name cannot be empty");
      }
      if (typeof color === "string" && color !== "" && !HEX_COLOR_RE.test(color)) throw new Error("color must be a valid hex color (e.g. #ef4444)");
      if (workspace !== undefined && typeof workspace !== "string") throw new Error("workspace must be a string");
      if (statuses !== undefined) validateStatusConfigs(statuses);
      const team = teamStore.updateTeam(id, {
        name: name?.trim(),
        color: typeof color === "string" ? color : undefined,
        workspace: typeof workspace === "string" ? workspace : undefined,
        variables: typeof variables === "object" && variables !== null ? variables : undefined,
        statuses,
      });
      if (!team) throw new Error(`Team not found: ${id}`);
      emit("teamChange", { action: "updated", team });
      return { team };
    },

    /** Delete a team and all its agents. */
    "teams.delete": async (params: unknown) => {
      const { id } = (params ?? {}) as { id?: string };
      if (!id || typeof id !== "string") throw new Error("id is required");
      const deleted = teamStore.deleteTeam(id);
      if (!deleted) throw new Error(`Team not found: ${id}`);
      emit("teamChange", { action: "deleted", id });
      return { teams: teamStore.toTeamConfigs() };
    },

    /** Add an agent to a team. */
    "teams.createAgent": async (params: unknown) => {
      const p = (params ?? {}) as Record<string, unknown>;
      const teamId = p.teamId as string | undefined;
      const name = p.name as string | undefined;
      const role = p.role as string | undefined;
      const model = p.model as string | undefined;
      if (!teamId || typeof teamId !== "string") throw new Error("teamId is required");
      if (!name || typeof name !== "string") throw new Error("name is required");
      if (name.length > MAX_NAME_LENGTH) throw new Error(`name exceeds maximum length of ${MAX_NAME_LENGTH}`);
      if (!role || !VALID_ROLES.has(role)) throw new Error("role must be 'orchestrator' or 'worker'");
      if (!model || typeof model !== "string") throw new Error("model is required");
      if (model.length > MAX_MODEL_LENGTH) throw new Error(`model exceeds maximum length of ${MAX_MODEL_LENGTH}`);
      if (typeof p.identity === "string" && p.identity.length > MAX_IDENTITY_LENGTH) throw new Error(`identity exceeds maximum length of ${MAX_IDENTITY_LENGTH}`);
      const agent = teamStore.createAgent(teamId, {
        name,
        role: role as "orchestrator" | "worker",
        model,
        contextWindow: typeof p.contextWindow === "number" ? p.contextWindow : undefined,
        maxSteps: typeof p.maxSteps === "number" ? p.maxSteps : undefined,
        identity: typeof p.identity === "string" ? p.identity : undefined,
        tools: Array.isArray(p.tools) ? p.tools.filter((t): t is string => typeof t === "string") : undefined,
        timeout: typeof p.timeout === "number" ? p.timeout : undefined,
        templateId: typeof p.templateId === "string" ? p.templateId : (p.templateId === null ? null : undefined),
        subscriptions: Array.isArray(p.subscriptions) ? p.subscriptions.filter((s): s is string => typeof s === "string") : undefined,
        concurrency: typeof p.concurrency === "number" ? p.concurrency : undefined,
      });
      emit("teamChange", { action: "agentCreated", agent });
      return { agent };
    },

    /** Update an agent's configuration. */
    "teams.updateAgent": async (params: unknown) => {
      const p = (params ?? {}) as Record<string, unknown>;
      const id = p.id as string | undefined;
      if (!id || typeof id !== "string") throw new Error("id is required");
      if (p.role !== undefined && !VALID_ROLES.has(p.role as string)) {
        throw new Error("role must be 'orchestrator' or 'worker'");
      }
      const agent = teamStore.updateAgent(id, {
        name: typeof p.name === "string" ? p.name : undefined,
        role: VALID_ROLES.has(p.role as string) ? (p.role as "orchestrator" | "worker") : undefined,
        model: typeof p.model === "string" ? p.model : undefined,
        contextWindow: typeof p.contextWindow === "number" ? p.contextWindow : undefined,
        maxSteps: typeof p.maxSteps === "number" ? p.maxSteps : undefined,
        identity: typeof p.identity === "string" ? p.identity : undefined,
        tools: Array.isArray(p.tools) ? p.tools.filter((t): t is string => typeof t === "string") : undefined,
        timeout: typeof p.timeout === "number" ? p.timeout : undefined,
        templateId: typeof p.templateId === "string" ? p.templateId : (p.templateId === null ? null : undefined),
        subscriptions: Array.isArray(p.subscriptions) ? p.subscriptions.filter((s): s is string => typeof s === "string") : undefined,
        concurrency: typeof p.concurrency === "number" ? p.concurrency : undefined,
      });
      if (!agent) throw new Error(`Agent not found: ${id}`);
      emit("teamChange", { action: "agentUpdated", agent });
      return { agent };
    },

    /** Remove an agent from a team. */
    "teams.deleteAgent": async (params: unknown) => {
      const { id } = (params ?? {}) as { id?: string };
      if (!id || typeof id !== "string") throw new Error("id is required");
      const deleted = teamStore.deleteAgent(id);
      if (!deleted) throw new Error(`Agent not found: ${id}`);
      emit("teamChange", { action: "agentDeleted", id });
      return { status: "ok" };
    },

    /* ---------------------------------------------------------------- */
    /*  Team memory methods                                              */
    /*  All endpoints reject DEFAULT_TEAM_ID — global memory is managed  */
    /*  by the agent automatically, not via the team memory UI.          */
    /* ---------------------------------------------------------------- */

    /** List memories for a team (paginated). */
    "teams.memories.list": async (params: unknown) => {
      if (!memoryStore) throw new Error("Memory is not enabled");
      const p = (params ?? {}) as { teamId?: string; limit?: number; offset?: number };
      requireNonDefaultTeamId(p.teamId);
      const limit = typeof p.limit === "number" ? Math.min(Math.max(1, p.limit), MAX_PAGE_SIZE) : 50;
      const offset = typeof p.offset === "number" ? Math.max(0, p.offset) : 0;
      return memoryStore.listByTeam(p.teamId!, limit, offset);
    },

    /** Search memories scoped to a team (returns global + team). */
    "teams.memories.search": async (params: unknown) => {
      if (!memoryStore) throw new Error("Memory is not enabled");
      const p = (params ?? {}) as { teamId?: string; query?: string; limit?: number };
      requireNonDefaultTeamId(p.teamId);
      if (!p.query || typeof p.query !== "string") throw new Error("query is required");
      const limit = typeof p.limit === "number" ? Math.min(Math.max(1, p.limit), MAX_PAGE_SIZE) : 20;
      const facts = await searchMemory(memoryStore, p.query, {
        limit,
        teamId: p.teamId!,
        embeddingProvider: embeddingProvider ?? undefined,
      });
      return { facts };
    },

    /** Manually add a memory for a team. */
    "teams.memories.add": async (params: unknown) => {
      if (!memoryStore) throw new Error("Memory is not enabled");
      const p = (params ?? {}) as { teamId?: string; fact?: string };
      requireNonDefaultTeamId(p.teamId);
      if (typeof p.fact !== "string") throw new Error("fact is required");
      const result = await saveExplicitMemory(memoryStore, embeddingProvider ?? null, {
        fact: p.fact,
        source: "manual",
        teamId: p.teamId!,
      });
      return result;
    },

    /** Delete a single memory by ID (team-scoped for authorization). */
    "teams.memories.delete": async (params: unknown) => {
      if (!memoryStore) throw new Error("Memory is not enabled");
      const p = (params ?? {}) as { id?: string; teamId?: string };
      if (!p.id || typeof p.id !== "string") throw new Error("id is required");
      requireNonDefaultTeamId(p.teamId);
      const deleted = memoryStore.deleteById(p.id, p.teamId!);
      if (!deleted) throw new Error(`Memory not found or not owned by this team: ${p.id}`);
      return { status: "ok" };
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Shared validation                                                 */
/* ------------------------------------------------------------------ */

/** Reject missing, empty, or default team IDs — team memory endpoints must target a real team. */
function requireNonDefaultTeamId(teamId: unknown): asserts teamId is string {
  if (!teamId || typeof teamId !== "string") throw new Error("teamId is required");
  if (teamId === DEFAULT_TEAM_ID) throw new Error("Team memory is only available for non-default teams");
}

/* ------------------------------------------------------------------ */
/*  Input validation for teams.save                                   */
/* ------------------------------------------------------------------ */

function validateAgentConfig(agent: unknown, label: string): void {
  if (typeof agent !== "object" || agent === null) throw new Error(`${label} must be an object`);
  const a = agent as Record<string, unknown>;
  if (typeof a.name !== "string" || a.name.trim().length === 0) throw new Error(`${label}.name is required`);
  if (a.name.length > MAX_NAME_LENGTH) throw new Error(`${label}.name exceeds maximum length of ${MAX_NAME_LENGTH}`);
  if (typeof a.model !== "string" || a.model.length === 0) throw new Error(`${label}.model is required`);
  if (a.model.length > MAX_MODEL_LENGTH) throw new Error(`${label}.model exceeds maximum length of ${MAX_MODEL_LENGTH}`);
  if (typeof a.identity === "string" && a.identity.length > MAX_IDENTITY_LENGTH) {
    throw new Error(`${label}.identity exceeds maximum length of ${MAX_IDENTITY_LENGTH}`);
  }
}

function validateTeamConfig(tc: unknown): void {
  const t = tc as Record<string, unknown>;
  if (typeof t.id !== "string" || t.id.trim().length === 0) throw new Error("team.id is required");
  if (typeof t.name !== "string" || t.name.trim().length === 0) throw new Error("team.name is required");
  if ((t.name as string).length > MAX_NAME_LENGTH) throw new Error(`team.name exceeds maximum length of ${MAX_NAME_LENGTH}`);
  if (typeof t.color === "string" && t.color !== "" && !HEX_COLOR_RE.test(t.color)) {
    throw new Error("team.color must be a valid hex color (e.g. #ef4444)");
  }
  if (t.workspace !== undefined && typeof t.workspace !== "string") {
    throw new Error("team.workspace must be a string");
  }
  if (t.variables !== undefined) {
    if (typeof t.variables !== "object" || t.variables === null || Array.isArray(t.variables)) {
      throw new Error("team.variables must be an object of string key-value pairs");
    }
    for (const [k, v] of Object.entries(t.variables as Record<string, unknown>)) {
      if (typeof v !== "string") throw new Error(`team.variables["${k}"] must be a string`);
    }
  }
  if (t.statuses !== undefined) validateStatusConfigs(t.statuses);
  if (t.orchestrator) {
    validateAgentConfig(t.orchestrator, "team.orchestrator");
  }
  if (Array.isArray(t.workers)) {
    for (let j = 0; j < (t.workers as unknown[]).length; j++) {
      validateAgentConfig((t.workers as unknown[])[j], `team.workers[${j}]`);
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Save a single team: create or update team + reconcile agents      */
/* ------------------------------------------------------------------ */

function saveTeam(store: TeamStore, tc: TeamConfig): void {
  const existing = store.getTeamById(tc.id);
  if (existing) {
    store.updateTeam(tc.id, {
      name: tc.name?.trim(),
      color: tc.color,
      workspace: tc.workspace,
      variables: tc.variables,
      statuses: tc.statuses,
    });
  } else {
    store.createTeam({
      id: tc.id,
      name: tc.name?.trim() ?? tc.id,
      color: tc.color ?? "",
      workspace: tc.workspace ?? "",
      variables: tc.variables ?? {},
      statuses: tc.statuses,
    });
  }
  syncAgents(store, tc.id, tc);
}

function syncAgents(store: TeamStore, teamId: string, tc: TeamConfig): void {
  const existingAgents = store.listAgentsByTeam(teamId);
  const existingById = new Map(existingAgents.map((a) => [a.id, a]));

  // Collect all incoming agent configs (orchestrator + workers)
  const incomingAgents: { config: AgentConfig; role: "orchestrator" | "worker" }[] = [];
  if (tc.orchestrator?.id) {
    incomingAgents.push({ config: tc.orchestrator, role: "orchestrator" });
  }
  for (const w of tc.workers ?? []) {
    if (w.id) incomingAgents.push({ config: w, role: "worker" });
  }
  const incomingAgentIds = new Set(incomingAgents.map((a) => a.config.id));

  // If the orchestrator id changed, delete the old one first so the new one can be created
  const existingOrchestrator = existingAgents.find((a) => a.role === "orchestrator");
  const incomingOrchestrator = incomingAgents.find((a) => a.role === "orchestrator");
  if (existingOrchestrator && incomingOrchestrator && existingOrchestrator.id !== incomingOrchestrator.config.id) {
    store.updateAgent(existingOrchestrator.id, { role: "worker" });
    store.deleteAgent(existingOrchestrator.id);
  }

  // Delete workers that were removed
  for (const agent of existingAgents) {
    if (!incomingAgentIds.has(agent.id) && agent.role === "worker") {
      try { store.deleteAgent(agent.id); } catch (err) {
        logger.warn(`teams.save: failed to delete agent ${agent.id}: ${err}`);
      }
    }
  }

  // Create or update agents
  for (const { config, role } of incomingAgents) {
    const agentFields = {
      name: config.name,
      role,
      model: config.model,
      contextWindow: config.contextWindow,
      maxSteps: config.maxSteps,
      identity: config.identity,
      tools: config.tools,
      timeout: config.timeout ?? DEFAULT_WORKER_TIMEOUT_S,
      templateId: config.templateId ?? null,
      subscriptions: config.subscriptions ?? [],
      concurrency: config.concurrency ?? 1,
    };
    if (existingById.has(config.id)) {
      store.updateAgent(config.id, agentFields);
    } else {
      store.createAgent(teamId, { id: config.id, ...agentFields });
    }
  }
}
