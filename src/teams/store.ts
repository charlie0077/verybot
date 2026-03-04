import { mkdirSync } from "fs";
import { dirname } from "path";
import { randomUUID } from "crypto";
import Database from "better-sqlite3";
import { logger } from "../logger.js";
import type { Team, AgentRow } from "./types.js";
import type { TeamConfig, AgentConfig, TaskStatusConfig } from "../config/agent-config.js";
import { DEFAULT_TEAM_ID, DEFAULT_WORKER_TIMEOUT_S, FALLBACK_ORCHESTRATOR } from "../config/agent-config.js";
import { LEGACY_STATUS_KEYS } from "../tasks/types.js";
import { validateStatusConfigs } from "./status-config.js";

/** Max allowed length for team/agent names. */
export const MAX_NAME_LENGTH = 128;
/** Max allowed length for agent identity strings. */
export const MAX_IDENTITY_LENGTH = 10_000;
/** Max allowed length for model strings. */
export const MAX_MODEL_LENGTH = 256;
/** Max allowed length for caller-provided ids. */
const MAX_ID_LENGTH = 128;
/** Concurrency bounds for worker agents. */
const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 10;
/** Hex color pattern: #RRGGBB */
export const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const DEFAULT_TEAM_NAME = "Default";

/** Validate a caller-provided id string. */
function validateId(id: string): void {
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new Error("id must be a non-empty string");
  }
  if (id.length > MAX_ID_LENGTH) {
    throw new Error(`id exceeds maximum length of ${MAX_ID_LENGTH}`);
  }
}

/** Max allowed length for workspace paths. */
const MAX_WORKSPACE_LENGTH = 1024;
/** Max number of user-defined variables per team. */
const MAX_VARIABLES_COUNT = 50;
/** Max allowed length for a single variable value. */
const MAX_VARIABLE_VALUE_LENGTH = 10_000;
/** Variable key pattern: alphanumeric + underscore. */
const VARIABLE_KEY_RE = /^\w+$/;

export interface CreateTeamInput {
  /** Optional caller-provided id. If omitted, a random UUID is generated. */
  id?: string;
  name: string;
  color?: string;
  workspace?: string;
  variables?: Record<string, string>;
  statuses?: TaskStatusConfig[];
}

export interface UpdateTeamInput {
  name?: string;
  color?: string;
  workspace?: string;
  variables?: Record<string, string>;
  statuses?: TaskStatusConfig[];
}

export interface CreateAgentInput {
  /** Optional caller-provided id. If omitted, a random UUID is generated. */
  id?: string;
  name: string;
  role: "orchestrator" | "worker";
  model: string;
  contextWindow?: number;
  maxSteps?: number;
  identity?: string;
  tools?: string[];
  timeout?: number;
  templateId?: string | null;
  subscriptions?: string[];
  concurrency?: number;
}

export interface UpdateAgentInput {
  name?: string;
  role?: "orchestrator" | "worker";
  model?: string;
  contextWindow?: number;
  maxSteps?: number;
  identity?: string;
  tools?: string[];
  timeout?: number;
  templateId?: string | null;
  subscriptions?: string[];
  concurrency?: number;
}

/**
 * SQLite-backed persistence for teams and agents.
 * Shares the same DB file as MemoryStore, TaskStore, etc.
 */
export class TeamStore {
  private db: Database.Database;

  private constructor(db: Database.Database) {
    this.db = db;
  }

  static async create(dbPath: string): Promise<TeamStore> {
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    const store = new TeamStore(db);
    store.createSchema();
    return store;
  }

  private createSchema(): void {
    // Enable foreign key enforcement before creating tables
    this.db.pragma("foreign_keys = ON");

    // Ensure prompt_templates table exists (may already be created by PromptTemplateStore)
    // Needed for agents.template_id FK and toTeamConfigs() JOIN.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS prompt_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        role TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        builtin INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS teams (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        model TEXT NOT NULL,
        context_window INTEGER DEFAULT 0,
        max_steps INTEGER DEFAULT 0,
        identity TEXT NOT NULL DEFAULT '',
        tools TEXT DEFAULT '[]',
        timeout INTEGER DEFAULT ${DEFAULT_WORKER_TIMEOUT_S},
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(team_id, name)
      );
      CREATE INDEX IF NOT EXISTS idx_agents_team ON agents(team_id);
    `);

    // Add color column to existing tables (idempotent — SQLite errors if column exists)
    try {
      this.db.exec("ALTER TABLE teams ADD COLUMN color TEXT NOT NULL DEFAULT ''");
    } catch {
      // Column already exists
    }

    // Add template_id FK column to agents (idempotent)
    try {
      this.db.exec("ALTER TABLE agents ADD COLUMN template_id TEXT REFERENCES prompt_templates(id) ON DELETE SET NULL");
    } catch {
      // Column already exists
    }

    // Add workspace column to teams (idempotent)
    try {
      this.db.exec("ALTER TABLE teams ADD COLUMN workspace TEXT NOT NULL DEFAULT ''");
    } catch {
      // Column already exists
    }

    // Add variables column to teams (JSON-encoded Record<string, string>)
    try {
      this.db.exec("ALTER TABLE teams ADD COLUMN variables TEXT NOT NULL DEFAULT '{}'");
    } catch {
      // Column already exists
    }

    // Add concurrency column to agents (default 1)
    try {
      this.db.exec("ALTER TABLE agents ADD COLUMN concurrency INTEGER NOT NULL DEFAULT 1");
    } catch {
      // Column already exists
    }

    // Add statuses column to teams (JSON-encoded TaskStatusConfig[])
    try {
      this.db.exec("ALTER TABLE teams ADD COLUMN statuses TEXT DEFAULT NULL");
    } catch {
      // Column already exists
    }

    // Agent subscriptions table for pull-based task execution
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_subscriptions (
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        task_status TEXT NOT NULL,
        PRIMARY KEY (agent_id, task_status)
      );
    `);
  }

  // --- Team CRUD ---

  /** Run a function inside a SQLite transaction (all-or-nothing). */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  createTeam(input: CreateTeamInput): Team {
    const { name, color = "", workspace = "", variables = {}, statuses } = input;
    if (input.id !== undefined) validateId(input.id);
    if (name.length > MAX_NAME_LENGTH) throw new Error(`Team name exceeds maximum length of ${MAX_NAME_LENGTH}`);
    if (color !== "" && !HEX_COLOR_RE.test(color)) throw new Error("color must be a valid hex color (e.g. #ef4444)");
    if (workspace.length > MAX_WORKSPACE_LENGTH) throw new Error(`workspace exceeds maximum length of ${MAX_WORKSPACE_LENGTH}`);
    if (statuses !== undefined) validateStatusConfigs(statuses);
    validateVariables(variables);
    const now = Date.now();
    const id = input.id ?? randomUUID();
    const statusesJson = statuses ? JSON.stringify(statuses) : null;
    try {
      this.db.prepare(
        "INSERT INTO teams (id, name, color, workspace, variables, statuses, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(id, name, color, workspace, JSON.stringify(variables), statusesJson, now, now);
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes("UNIQUE constraint")) {
        throw new Error(`A team named "${name}" already exists`);
      }
      throw err;
    }
    return { id, name, color, workspace, statuses: statuses ?? undefined, createdAt: now, updatedAt: now };
  }

  updateTeam(id: string, input: UpdateTeamInput): Team | null {
    const existing = this.getTeamById(id);
    if (!existing) return null;
    const name = input.name ?? existing.name;
    if (name.length > MAX_NAME_LENGTH) throw new Error(`Team name exceeds maximum length of ${MAX_NAME_LENGTH}`);
    const color = input.color ?? existing.color;
    const workspace = input.workspace ?? existing.workspace;
    if (color !== "" && !HEX_COLOR_RE.test(color)) throw new Error("color must be a valid hex color (e.g. #ef4444)");
    if (workspace.length > MAX_WORKSPACE_LENGTH) throw new Error(`workspace exceeds maximum length of ${MAX_WORKSPACE_LENGTH}`);
    // Variables: replace entirely if provided, otherwise keep existing
    let variables: Record<string, string> | undefined;
    if (input.variables !== undefined) {
      validateVariables(input.variables);
      variables = input.variables;
    }
    const varsJson = variables !== undefined ? JSON.stringify(variables) : undefined;
    // Statuses: replace entirely if provided, otherwise keep existing
    if (input.statuses !== undefined) validateStatusConfigs(input.statuses);
    const statuses = input.statuses !== undefined ? input.statuses : existing.statuses;
    const statusesJson = input.statuses !== undefined ? (input.statuses ? JSON.stringify(input.statuses) : null) : undefined;
    const now = Date.now();
    const sets = ["name = ?", "color = ?", "workspace = ?", "updated_at = ?"];
    const params: unknown[] = [name, color, workspace, now];
    if (varsJson !== undefined) {
      sets.splice(3, 0, "variables = ?");
      params.splice(3, 0, varsJson);
    }
    if (statusesJson !== undefined) {
      sets.splice(sets.length - 1, 0, "statuses = ?");
      params.splice(params.length - 1, 0, statusesJson);
    }
    params.push(id);
    this.db.prepare(`UPDATE teams SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    return { ...existing, name, color, workspace, statuses: statuses ?? undefined, updatedAt: now };
  }

  deleteTeam(id: string): boolean {
    if (id === DEFAULT_TEAM_ID) throw new Error("Cannot delete the default team");
    const info = this.db.prepare("DELETE FROM teams WHERE id = ?").run(id);
    return info.changes > 0;
  }

  getTeamById(id: string): Team | null {
    const row = this.db.prepare("SELECT * FROM teams WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? toTeam(row) : null;
  }

  getTeamByName(name: string): Team | null {
    const row = this.db.prepare("SELECT * FROM teams WHERE name = ?").get(name) as Record<string, unknown> | undefined;
    return row ? toTeam(row) : null;
  }

  listTeams(): Team[] {
    const rows = this.db.prepare("SELECT * FROM teams ORDER BY created_at ASC").all() as Record<string, unknown>[];
    return rows.map(toTeam);
  }

  /**
   * Bootstrap helper:
   * guarantees a team row with id "default" exists.
   */
  ensureTeamWhenEmpty(): Team | null {
    const existing = this.getTeamById(DEFAULT_TEAM_ID);
    if (existing) return existing;
    return this.createTeam({ id: DEFAULT_TEAM_ID, name: DEFAULT_TEAM_NAME });
  }

  // --- Agent CRUD ---

  createAgent(teamId: string, input: CreateAgentInput): AgentRow {
    if (input.id !== undefined) validateId(input.id);
    if (input.name.length > MAX_NAME_LENGTH) throw new Error(`Agent name exceeds maximum length of ${MAX_NAME_LENGTH}`);
    if (input.model.length > MAX_MODEL_LENGTH) throw new Error(`Model string exceeds maximum length of ${MAX_MODEL_LENGTH}`);
    if (input.identity && input.identity.length > MAX_IDENTITY_LENGTH) throw new Error(`Identity exceeds maximum length of ${MAX_IDENTITY_LENGTH}`);

    // Verify team exists (friendly error instead of FK violation)
    const team = this.getTeamById(teamId);
    if (!team) throw new Error(`Team not found: ${teamId}`);

    // Prevent multiple orchestrators per team
    if (input.role === "orchestrator") {
      const existing = this.db.prepare(
        "SELECT id FROM agents WHERE team_id = ? AND role = 'orchestrator'",
      ).get(teamId);
      if (existing) throw new Error("Team already has an orchestrator — update the existing one instead");
    }

    const concurrency = input.concurrency ?? 1;
    if (concurrency < MIN_CONCURRENCY || concurrency > MAX_CONCURRENCY) {
      throw new Error(`concurrency must be between ${MIN_CONCURRENCY} and ${MAX_CONCURRENCY}`);
    }
    const subscriptions = input.subscriptions ?? [];
    // Validate against team's custom statuses if present
    const teamStatusKeys = team.statuses?.map((s) => s.key);
    validateSubscriptions(subscriptions, teamStatusKeys);

    const now = Date.now();
    const id = input.id ?? randomUUID();
    try {
      this.db.transaction(() => {
        this.db.prepare(
          `INSERT INTO agents (id, team_id, name, role, model, context_window, max_steps, identity, tools, timeout, template_id, concurrency, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id, teamId, input.name, input.role, input.model,
          input.contextWindow ?? 0, input.maxSteps ?? 0,
          input.identity ?? "", JSON.stringify(input.tools ?? []),
          input.timeout ?? DEFAULT_WORKER_TIMEOUT_S,
          input.templateId ?? null, concurrency, now, now,
        );
        if (subscriptions.length > 0) {
          const ins = this.db.prepare("INSERT INTO agent_subscriptions (agent_id, task_status) VALUES (?, ?)");
          for (const s of subscriptions) ins.run(id, s);
        }
      })();
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes("UNIQUE constraint")) {
        throw new Error(`Agent "${input.name}" already exists in this team`);
      }
      throw err;
    }
    return {
      id, teamId, name: input.name, role: input.role, model: input.model,
      contextWindow: input.contextWindow ?? 0, maxSteps: input.maxSteps ?? 0,
      identity: input.identity ?? "", tools: input.tools ?? [],
      timeout: input.timeout ?? DEFAULT_WORKER_TIMEOUT_S,
      templateId: input.templateId ?? null,
      subscriptions, concurrency,
      createdAt: now, updatedAt: now,
    };
  }

  updateAgent(id: string, input: UpdateAgentInput): AgentRow | null {
    if (input.name !== undefined && input.name.length > MAX_NAME_LENGTH) throw new Error(`Agent name exceeds maximum length of ${MAX_NAME_LENGTH}`);
    if (input.model !== undefined && input.model.length > MAX_MODEL_LENGTH) throw new Error(`Model string exceeds maximum length of ${MAX_MODEL_LENGTH}`);
    if (input.identity !== undefined && input.identity.length > MAX_IDENTITY_LENGTH) throw new Error(`Identity exceeds maximum length of ${MAX_IDENTITY_LENGTH}`);
    if (input.concurrency !== undefined && (input.concurrency < MIN_CONCURRENCY || input.concurrency > MAX_CONCURRENCY)) {
      throw new Error(`concurrency must be between ${MIN_CONCURRENCY} and ${MAX_CONCURRENCY}`);
    }
    const existing = this.getAgentById(id);
    if (!existing) return null;
    if (input.subscriptions !== undefined) {
      const team = this.getTeamById(existing.teamId);
      const teamStatusKeys = team?.statuses?.map((s) => s.key);
      validateSubscriptions(input.subscriptions, teamStatusKeys);
    }
    const now = Date.now();
    const updated: AgentRow = {
      ...existing,
      ...(input.name !== undefined && { name: input.name }),
      ...(input.role !== undefined && { role: input.role }),
      ...(input.model !== undefined && { model: input.model }),
      ...(input.contextWindow !== undefined && { contextWindow: input.contextWindow }),
      ...(input.maxSteps !== undefined && { maxSteps: input.maxSteps }),
      ...(input.identity !== undefined && { identity: input.identity }),
      ...(input.tools !== undefined && { tools: input.tools }),
      ...(input.timeout !== undefined && { timeout: input.timeout }),
      ...(input.templateId !== undefined && { templateId: input.templateId }),
      ...(input.subscriptions !== undefined && { subscriptions: input.subscriptions }),
      ...(input.concurrency !== undefined && { concurrency: input.concurrency }),
      updatedAt: now,
    };
    this.db.transaction(() => {
      this.db.prepare(
        `UPDATE agents SET name = ?, role = ?, model = ?, context_window = ?, max_steps = ?,
         identity = ?, tools = ?, timeout = ?, template_id = ?, concurrency = ?, updated_at = ? WHERE id = ?`,
      ).run(
        updated.name, updated.role, updated.model, updated.contextWindow,
        updated.maxSteps, updated.identity, JSON.stringify(updated.tools),
        updated.timeout, updated.templateId ?? null, updated.concurrency, now, id,
      );
      if (input.subscriptions !== undefined) {
        this.setSubscriptions(id, input.subscriptions);
      }
    })();
    return updated;
  }

  deleteAgent(id: string): boolean {
    // Prevent deleting a team's only orchestrator
    const agent = this.getAgentById(id);
    if (agent?.role === "orchestrator") {
      throw new Error("Cannot delete a team's orchestrator agent");
    }
    const info = this.db.prepare("DELETE FROM agents WHERE id = ?").run(id);
    return info.changes > 0;
  }

  getAgentById(id: string): AgentRow | null {
    const row = this.db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return toAgentRow(row, this.getSubscriptions(id));
  }

  /**
   * Runtime lookup for agent execution.
   * Resolves template-linked identity and interpolates team variables.
   */
  getRuntimeAgentById(id: string): AgentRow | null {
    const row = this.db.prepare(
      `SELECT a.*,
              t.name AS tname,
              t.workspace AS tworkspace,
              t.variables AS tvariables,
              pt.content AS template_content
       FROM agents a
       LEFT JOIN teams t ON t.id = a.team_id
       LEFT JOIN prompt_templates pt ON a.template_id = pt.id
       WHERE a.id = ?`,
    ).get(id) as Record<string, unknown> | undefined;
    if (!row) return null;

    const resolvedIdentity = resolveAgentIdentity({
      templateId: (row.template_id as string) ?? null,
      templateContent: (row.template_content as string) ?? null,
      rawIdentity: (row.identity as string) ?? "",
      teamName: (row.tname as string) ?? "",
      workspace: (row.tworkspace as string) ?? "",
      teamVariables: parseTeamVariables(row.tvariables),
    });
    return toAgentRow(row, this.getSubscriptions(id), resolvedIdentity);
  }

  listAgentsByTeam(teamId: string): AgentRow[] {
    const rows = this.db.prepare("SELECT * FROM agents WHERE team_id = ? ORDER BY role ASC, created_at ASC").all(teamId) as Record<string, unknown>[];
    if (rows.length === 0) return [];
    // Batch-load subscriptions to avoid N+1 queries
    const agentIds = rows.map((r) => r.id as string);
    const placeholders = agentIds.map(() => "?").join(", ");
    const subRows = this.db.prepare(
      `SELECT agent_id, task_status FROM agent_subscriptions WHERE agent_id IN (${placeholders})`,
    ).all(...agentIds) as { agent_id: string; task_status: string }[];
    const subsMap = new Map<string, string[]>();
    for (const s of subRows) {
      if (!subsMap.has(s.agent_id)) subsMap.set(s.agent_id, []);
      subsMap.get(s.agent_id)!.push(s.task_status);
    }
    return rows.map((row) => toAgentRow(row, subsMap.get(row.id as string)));
  }

  getAgentByName(teamId: string, name: string): AgentRow | null {
    const row = this.db.prepare("SELECT * FROM agents WHERE team_id = ? AND name = ?").get(teamId, name) as Record<string, unknown> | undefined;
    if (!row) return null;
    return toAgentRow(row, this.getSubscriptions(row.id as string));
  }

  // --- Subscription CRUD ---

  /** Replace an agent's subscriptions (transactional delete + reinsert). */
  setSubscriptions(agentId: string, statuses: string[]): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM agent_subscriptions WHERE agent_id = ?").run(agentId);
      const insert = this.db.prepare("INSERT INTO agent_subscriptions (agent_id, task_status) VALUES (?, ?)");
      for (const status of statuses) {
        insert.run(agentId, status);
      }
    })();
  }

  /** Get an agent's subscribed task statuses. */
  getSubscriptions(agentId: string): string[] {
    const rows = this.db.prepare(
      "SELECT task_status FROM agent_subscriptions WHERE agent_id = ?",
    ).all(agentId) as { task_status: string }[];
    return rows.map((r) => r.task_status);
  }

  /**
   * Find claimable tasks by joining tasks, agent_subscriptions, and agents tables.
   * Uses task_claims for dedup (no existing claim for agent+task+status) and concurrency.
   */
  findClaimableTasks(limit: number): {
    taskId: string; taskStatus: string; agentId: string; teamId: string;
    agentName: string; model: string; concurrency: number;
  }[] {
    const rows = this.db.prepare(`
      SELECT t.id AS task_id, t.status AS task_status, s.agent_id, a.team_id, a.name AS agent_name, a.model, a.concurrency
      FROM tasks t
      JOIN agent_subscriptions s ON s.task_status = t.status
      JOIN agents a ON a.id = s.agent_id
      LEFT JOIN task_claims c
        ON c.task_id = t.id
        AND c.agent_id = s.agent_id
        AND c.task_status = t.status
      WHERE c.task_id IS NULL
        AND t.needs_human_review = 0
        AND t.team_id = a.team_id
        AND (t.assignee IS NULL OR t.assignee = s.agent_id)
        AND (
          SELECT COUNT(*)
          FROM task_claims active
          WHERE active.agent_id = s.agent_id AND active.completed_at IS NULL
        ) < a.concurrency
      ORDER BY
        CASE WHEN t.assignee = s.agent_id THEN 0 ELSE 1 END,
        CASE WHEN EXISTS(
          SELECT 1 FROM task_claims ac
          WHERE ac.task_id = t.id AND ac.task_status = t.status
            AND ac.completed_at IS NULL AND ac.agent_id != s.agent_id
        ) THEN 1 ELSE 0 END,
        t.created_at ASC
      LIMIT ?
    `).all(limit) as {
      task_id: string; task_status: string; agent_id: string; team_id: string;
      agent_name: string; model: string; concurrency: number;
    }[];
    return rows.map((r) => ({
      taskId: r.task_id,
      taskStatus: r.task_status,
      agentId: r.agent_id,
      teamId: r.team_id,
      agentName: r.agent_name,
      model: r.model,
      concurrency: r.concurrency,
    }));
  }

  /**
   * Get all agent IDs subscribed to a given task status within a team.
   */
  getSubscribersForStatus(teamId: string, taskStatus: string): string[] {
    const rows = this.db.prepare(
      `SELECT s.agent_id
       FROM agent_subscriptions s
       JOIN agents a ON a.id = s.agent_id
       WHERE s.task_status = ? AND a.team_id = ?`,
    ).all(taskStatus, teamId) as { agent_id: string }[];
    return rows.map((r) => r.agent_id);
  }

  /**
   * Convert DB rows to the existing TeamConfig[] format so TeamRegistry
   * constructor is unchanged. Uses a single JOIN query instead of N+1.
   */
  toTeamConfigs(): TeamConfig[] {
    const rows = this.db.prepare(
      `SELECT t.id AS tid, t.name AS tname, t.color AS tcolor,
              t.workspace AS tworkspace, t.variables AS tvariables,
              t.statuses AS tstatuses,
              a.id, a.name, a.role, a.model, a.context_window, a.max_steps,
              a.identity, a.tools, a.timeout, a.template_id, a.concurrency,
              pt.content AS template_content
       FROM teams t LEFT JOIN agents a ON a.team_id = t.id
       LEFT JOIN prompt_templates pt ON a.template_id = pt.id
       WHERE t.id != ?
       ORDER BY t.created_at ASC, a.role ASC, a.created_at ASC`,
    ).all(DEFAULT_TEAM_ID) as Record<string, unknown>[];

    // Batch-load all subscriptions into a map
    const allSubs = this.db.prepare(
      "SELECT agent_id, task_status FROM agent_subscriptions",
    ).all() as { agent_id: string; task_status: string }[];
    const subsMap = new Map<string, string[]>();
    for (const s of allSubs) {
      if (!subsMap.has(s.agent_id)) subsMap.set(s.agent_id, []);
      subsMap.get(s.agent_id)!.push(s.task_status);
    }

    const teamMap = new Map<string, TeamConfig>();
    for (const row of rows) {
      const tid = row.tid as string;
      if (!teamMap.has(tid)) {
        let variables: Record<string, string> = {};
        try { variables = JSON.parse((row.tvariables as string) || "{}"); } catch { /* ignore */ }
        let statuses: TaskStatusConfig[] | undefined;
        if (typeof row.tstatuses === "string" && row.tstatuses) {
          try { statuses = JSON.parse(row.tstatuses); } catch { /* ignore */ }
        }
        teamMap.set(tid, {
          id: tid,
          name: row.tname as string,
          color: (row.tcolor as string) ?? "",
          workspace: (row.tworkspace as string) ?? "",
          variables,
          statuses,
          orchestrator: { ...FALLBACK_ORCHESTRATOR },
          workers: [],
        });
      }
      // LEFT JOIN may produce a row with no agent columns
      if (!row.id) continue;
      const team = teamMap.get(tid)!;
      const agentId = row.id as string;
      const agent = toAgentConfig(row, team.variables, subsMap.get(agentId));
      if ((row.role as string) === "orchestrator") {
        team.orchestrator = agent;
      } else {
        team.workers.push(agent);
      }
    }
    return [...teamMap.values()];
  }

  close(): void {
    this.db.close();
    logger.info("Team store closed");
  }
}

function toTeam(row: Record<string, unknown>): Team {
  let statuses: TaskStatusConfig[] | undefined;
  if (typeof row.statuses === "string" && row.statuses) {
    try { statuses = JSON.parse(row.statuses); } catch { /* ignore */ }
  }
  return {
    id: row.id as string,
    name: row.name as string,
    color: (row.color as string) ?? "",
    workspace: (row.workspace as string) ?? "",
    statuses,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

function toAgentConfig(row: Record<string, unknown>, teamVariables?: Record<string, string>, subscriptions?: string[]): AgentConfig {
  let tools: string[] = [];
  try { tools = JSON.parse((row.tools as string) || "[]"); } catch { tools = []; }
  const templateId = (row.template_id as string) ?? null;
  const identity = resolveAgentIdentity({
    templateId,
    templateContent: (row.template_content as string) ?? null,
    rawIdentity: (row.identity as string) ?? "",
    teamName: (row.tname as string) ?? "",
    workspace: (row.tworkspace as string) ?? "",
    teamVariables,
  });

  return {
    id: row.id as string,
    name: row.name as string,
    model: row.model as string,
    contextWindow: (row.context_window as number) ?? 0,
    maxSteps: (row.max_steps as number) ?? 0,
    identity,
    tools,
    timeout: (row.timeout as number) ?? DEFAULT_WORKER_TIMEOUT_S,
    templateId,
    subscriptions: subscriptions ?? [],
    concurrency: (row.concurrency as number) ?? 1,
  };
}

function validateVariables(variables: Record<string, string>): void {
  const keys = Object.keys(variables);
  if (keys.length > MAX_VARIABLES_COUNT) {
    throw new Error(`Too many variables (max ${MAX_VARIABLES_COUNT})`);
  }
  for (const key of keys) {
    if (!VARIABLE_KEY_RE.test(key)) {
      throw new Error(`Invalid variable key "${key}": only letters, numbers, and underscores allowed`);
    }
    if (typeof variables[key] !== "string") {
      throw new Error(`Variable "${key}" must have a string value`);
    }
    if (variables[key].length > MAX_VARIABLE_VALUE_LENGTH) {
      throw new Error(`Variable "${key}" value exceeds maximum length of ${MAX_VARIABLE_VALUE_LENGTH}`);
    }
  }
}

/** Legacy fallback for teams without custom statuses. */
const LEGACY_VALID_STATUSES = new Set<string>(LEGACY_STATUS_KEYS);

function validateSubscriptions(statuses: string[], validStatuses?: string[]): void {
  const allowed = validStatuses ? new Set(validStatuses) : LEGACY_VALID_STATUSES;
  for (const s of statuses) {
    if (!allowed.has(s)) {
      const validList = validStatuses ? validStatuses.join(", ") : LEGACY_STATUS_KEYS.join(", ");
      throw new Error(`Invalid subscription status "${s}". Valid: ${validList}`);
    }
  }
}

function toAgentRow(row: Record<string, unknown>, subscriptions?: string[], identityOverride?: string): AgentRow {
  let tools: string[] = [];
  try {
    tools = JSON.parse((row.tools as string) || "[]");
  } catch {
    tools = [];
  }
  return {
    id: row.id as string,
    teamId: row.team_id as string,
    name: row.name as string,
    role: row.role as "orchestrator" | "worker",
    model: row.model as string,
    contextWindow: (row.context_window as number) ?? 0,
    maxSteps: (row.max_steps as number) ?? 0,
    identity: identityOverride ?? ((row.identity as string) ?? ""),
    tools,
    timeout: (row.timeout as number) ?? DEFAULT_WORKER_TIMEOUT_S,
    templateId: (row.template_id as string) ?? null,
    subscriptions: subscriptions ?? [],
    concurrency: (row.concurrency as number) ?? 1,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

function parseTeamVariables(raw: unknown): Record<string, string> {
  if (typeof raw !== "string" || raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function resolveAgentIdentity(input: {
  templateId: string | null;
  templateContent: string | null;
  rawIdentity: string;
  teamName: string;
  workspace: string;
  teamVariables?: Record<string, string>;
}): string {
  const {
    templateId,
    templateContent,
    rawIdentity,
    teamName,
    workspace,
    teamVariables,
  } = input;
  const baseIdentity = templateId && templateContent != null ? templateContent : rawIdentity;
  if (!baseIdentity) return "";

  const variables: Record<string, string> = {
    teamName,
    workspace,
    ...(teamVariables ?? {}),
  };
  return baseIdentity.replace(/\{\{(\w+)\}\}/g, (_, key: string) => variables[key] ?? `{{${key}}}`);
}
