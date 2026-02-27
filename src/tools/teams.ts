import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { TeamStore } from "../teams/store.js";
import type { PromptTemplateStore } from "../prompt-templates/store.js";
import { DEFAULT_TASK_STATUSES, type TaskStatusConfig } from "../tasks/types.js";
import { REQUIRED_DONE_STATUS_KEY, validateStatusConfigs } from "../teams/status-config.js";
import { emit } from "../events.js";

const TEAM_COLOR_SCHEMA = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Team color must be a valid hex color (e.g. #ef4444)");
const STATUS_KEY_PATTERN = /^\w+$/;
const STATUS_KEY_SCHEMA = z.string().min(1).max(128).regex(STATUS_KEY_PATTERN, "Status key must be alphanumeric/underscore");
const STATUS_LABEL_SCHEMA = z.string().trim().min(1);
const STATUS_COLOR_SCHEMA = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Status color must be a valid hex color (e.g. #64748b)");
const SCOPED_TEAM_MISMATCH_MESSAGE = "This tool is scoped to team";

type TeamManagementToolName =
  | "team_list"
  | "team_create"
  | "team_update"
  | "team_status_list"
  | "team_status_get"
  | "team_status_add"
  | "team_status_update"
  | "team_status_delete"
  | "orchestrator_update"
  | "worker_create"
  | "worker_update"
  | "worker_delete";

interface TeamManagementToolOptions {
  /** Optional hard scope: all team-aware operations are constrained to this team. */
  scopeTeamId?: string;
  /** Optional subset to expose from the full team management toolset. */
  enabledTools?: TeamManagementToolName[];
}

const TEAM_WORKER_CRUD_TOOL_NAMES: TeamManagementToolName[] = [
  "worker_create",
  "worker_update",
  "worker_delete",
];

/**
 * Creates AI-facing tools for team and worker management.
 * Available to the default team orchestrator.
 * All mutating tools accept an optional teamId (defaults to the default team).
 */
export function createTeamManagementTools(
  teamStore: TeamStore,
  defaultTeamId: string,
  promptTemplateStore?: PromptTemplateStore,
  options?: TeamManagementToolOptions,
): ToolSet {
  const scopedTeamId = options?.scopeTeamId;
  const enabledTools = options?.enabledTools ? new Set(options.enabledTools) : null;

  /** Validates a template ID exists. Returns an error string or null if valid. */
  function validateTemplate(templateId: string | undefined): string | null {
    if (templateId === undefined || templateId === "") return null;
    const tpl = promptTemplateStore?.getPromptTemplateById(templateId);
    if (!tpl) return `Prompt template not found: ${templateId}`;
    return null;
  }

  function resolveTargetTeamId(teamId?: string): { targetTeamId: string; scopeError?: string } {
    if (scopedTeamId && teamId && teamId !== scopedTeamId) {
      return { targetTeamId: scopedTeamId, scopeError: `${SCOPED_TEAM_MISMATCH_MESSAGE}: ${scopedTeamId}` };
    }
    return { targetTeamId: scopedTeamId ?? teamId ?? defaultTeamId };
  }

  function resolveTeam(teamId?: string) {
    const { targetTeamId, scopeError } = resolveTargetTeamId(teamId);
    if (scopeError) return { targetTeamId, team: null, scopeError };
    const team = teamStore.getTeamById(targetTeamId);
    return { targetTeamId, team };
  }

  function isAgentInScope(agentTeamId: string): boolean {
    return !scopedTeamId || agentTeamId === scopedTeamId;
  }

  function getEffectiveStatuses(statuses?: TaskStatusConfig[]): TaskStatusConfig[] {
    const source = statuses && statuses.length > 0 ? statuses : DEFAULT_TASK_STATUSES;
    return source.map((status) => ({ ...status }));
  }

  function formatStatusLine(status: TaskStatusConfig): string {
    return `- ${status.key} — ${status.label} (${status.color})`;
  }

  const teamList = tool({
    description:
      "List all teams and their agents (orchestrators + workers).",
    inputSchema: z.object({}),
    execute: async () => {
      try {
        const teams = teamStore.listTeams().filter((team) => team.id !== defaultTeamId);
        if (teams.length === 0) return "No teams found.";
        const lines = teams.map((team) => {
          const agents = teamStore.listAgentsByTeam(team.id);
          const agentLines = agents
            .map((a) => {
              const parts = [`${a.role}`, `model: ${a.model}`, `id: ${a.id}`];
              if (a.templateId) parts.push(`template: ${a.templateId}`);
              return `  - ${a.name} (${parts.join(", ")})`;
            })
            .join("\n");
          const colorStr = team.color ? `, color: ${team.color}` : "";
          return `**${team.name}** (id: ${team.id}${colorStr})\n${agentLines || "  (no agents)"}`;
        });
        return lines.join("\n\n");
      } catch (err) {
        return `Failed to list teams: ${err instanceof Error ? err.message : err}`;
      }
    },
  });

  const teamCreate = tool({
    description:
      "Create a new team with a unique name. Optionally provide teamId and color.",
    inputSchema: z.object({
      name: z.string().trim().min(1).describe("Team name"),
      teamId: z.string().optional().describe("Optional explicit team ID"),
      color: TEAM_COLOR_SCHEMA.optional().describe("Optional team color hex (e.g. #ef4444)"),
    }),
    execute: async ({ name, teamId, color }) => {
      try {
        const team = teamStore.createTeam({ id: teamId, name, color });
        emit("teamChange", { action: "created", team });
        return `Team created: "${team.name}" (id: ${team.id})`;
      } catch (err) {
        return `Failed to create team: ${err instanceof Error ? err.message : err}`;
      }
    },
  });

  const teamUpdate = tool({
    description: "Update a team's name or color. Defaults to the default team if no teamId is provided.",
    inputSchema: z.object({
      teamId: z.string().optional().describe("Team ID to update (defaults to the default team)"),
      name: z.string().optional().describe("New team name"),
      color: TEAM_COLOR_SCHEMA.optional().describe("New hex color (e.g. #ef4444)"),
    }),
    execute: async ({ teamId, name, color }) => {
      try {
        const { targetTeamId, scopeError } = resolveTargetTeamId(teamId);
        if (scopeError) return scopeError;
        const team = teamStore.updateTeam(targetTeamId, { name, color });
        if (!team) return `Team not found: ${targetTeamId}`;
        emit("teamChange", { action: "updated", team });
        return `Team updated: "${team.name}" (id: ${team.id})`;
      } catch (err) {
        return `Failed to update team: ${err instanceof Error ? err.message : err}`;
      }
    },
  });

  const teamStatusList = tool({
    description:
      "List task statuses for a team. Returns the effective status set (custom statuses if configured, otherwise defaults).",
    inputSchema: z.object({
      teamId: z.string().optional().describe("Team ID (defaults to the default team)"),
    }),
    execute: async ({ teamId }) => {
      try {
        const { targetTeamId, team, scopeError } = resolveTeam(teamId);
        if (scopeError) return scopeError;
        if (!team) return `Team not found: ${targetTeamId}`;

        const hasCustomStatuses = !!team.statuses && team.statuses.length > 0;
        const statuses = getEffectiveStatuses(team.statuses);
        const source = hasCustomStatuses ? "custom" : "default";
        return [
          `Task statuses for "${team.name}" (id: ${team.id}, source: ${source}):`,
          ...statuses.map(formatStatusLine),
        ].join("\n");
      } catch (err) {
        return `Failed to list task statuses: ${err instanceof Error ? err.message : err}`;
      }
    },
  });

  const teamStatusGet = tool({
    description:
      "Get a single task status by key for a team (reads from custom statuses when configured, otherwise default statuses).",
    inputSchema: z.object({
      teamId: z.string().optional().describe("Team ID (defaults to the default team)"),
      key: STATUS_KEY_SCHEMA.describe("Status key to fetch"),
    }),
    execute: async ({ teamId, key }) => {
      try {
        const { targetTeamId, team, scopeError } = resolveTeam(teamId);
        if (scopeError) return scopeError;
        if (!team) return `Team not found: ${targetTeamId}`;

        const statuses = getEffectiveStatuses(team.statuses);
        const status = statuses.find((candidate) => candidate.key === key);
        if (!status) return `Status not found: ${key}`;

        return [
          `Task status for "${team.name}" (id: ${team.id}):`,
          formatStatusLine(status),
        ].join("\n");
      } catch (err) {
        return `Failed to get task status: ${err instanceof Error ? err.message : err}`;
      }
    },
  });

  const teamStatusAdd = tool({
    description:
      "Add a task status to a team. If the team has no custom statuses yet, defaults are copied first and the new status is appended.",
    inputSchema: z.object({
      teamId: z.string().optional().describe("Team ID (defaults to the default team)"),
      key: STATUS_KEY_SCHEMA.describe("New status key"),
      label: STATUS_LABEL_SCHEMA.describe("Display label"),
      color: STATUS_COLOR_SCHEMA.describe("Hex color"),
    }),
    execute: async ({ teamId, key, label, color }) => {
      try {
        const { targetTeamId, team, scopeError } = resolveTeam(teamId);
        if (scopeError) return scopeError;
        if (!team) return `Team not found: ${targetTeamId}`;

        const statuses = getEffectiveStatuses(team.statuses);
        if (statuses.some((status) => status.key === key)) {
          return `Status already exists: ${key}`;
        }

        const nextStatuses = [...statuses, { key, label, color }];
        validateStatusConfigs(nextStatuses);
        const updatedTeam = teamStore.updateTeam(targetTeamId, { statuses: nextStatuses });
        if (!updatedTeam) return `Team not found: ${targetTeamId}`;

        emit("teamChange", { action: "updated", team: updatedTeam });
        return `Task status added for team "${updatedTeam.name}": ${key}`;
      } catch (err) {
        return `Failed to add task status: ${err instanceof Error ? err.message : err}`;
      }
    },
  });

  const teamStatusUpdate = tool({
    description:
      "Update a team task status by key. The status key is immutable; only label/color can be changed.",
    inputSchema: z.object({
      teamId: z.string().optional().describe("Team ID (defaults to the default team)"),
      key: STATUS_KEY_SCHEMA.describe("Status key to update"),
      label: STATUS_LABEL_SCHEMA.optional().describe("Updated display label"),
      color: STATUS_COLOR_SCHEMA.optional().describe("Updated hex color"),
    }).refine(
      (input) => input.label !== undefined || input.color !== undefined,
      { message: "At least one of label or color must be provided" },
    ),
    execute: async ({ teamId, key, label, color }) => {
      try {
        const { targetTeamId, team, scopeError } = resolveTeam(teamId);
        if (scopeError) return scopeError;
        if (!team) return `Team not found: ${targetTeamId}`;

        const statuses = getEffectiveStatuses(team.statuses);
        const statusIndex = statuses.findIndex((status) => status.key === key);
        if (statusIndex < 0) return `Status not found: ${key}`;

        const status = statuses[statusIndex]!;
        const nextStatuses = statuses.map((candidate, index) =>
          index === statusIndex
            ? { ...candidate, label: label ?? status.label, color: color ?? status.color }
            : candidate
        );
        validateStatusConfigs(nextStatuses);
        const updatedTeam = teamStore.updateTeam(targetTeamId, { statuses: nextStatuses });
        if (!updatedTeam) return `Team not found: ${targetTeamId}`;

        emit("teamChange", { action: "updated", team: updatedTeam });
        return `Task status updated for team "${updatedTeam.name}": ${key}`;
      } catch (err) {
        return `Failed to update task status: ${err instanceof Error ? err.message : err}`;
      }
    },
  });

  const teamStatusDelete = tool({
    description:
      `Delete a task status from a team by key. The "${REQUIRED_DONE_STATUS_KEY}" status cannot be deleted.`,
    inputSchema: z.object({
      teamId: z.string().optional().describe("Team ID (defaults to the default team)"),
      key: STATUS_KEY_SCHEMA.describe("Status key to delete"),
    }),
    execute: async ({ teamId, key }) => {
      try {
        if (key === REQUIRED_DONE_STATUS_KEY) {
          return `Cannot delete required status: ${REQUIRED_DONE_STATUS_KEY}`;
        }

        const { targetTeamId, team, scopeError } = resolveTeam(teamId);
        if (scopeError) return scopeError;
        if (!team) return `Team not found: ${targetTeamId}`;

        const statuses = getEffectiveStatuses(team.statuses);
        if (!statuses.some((status) => status.key === key)) {
          return `Status not found: ${key}`;
        }
        const nextStatuses = statuses.filter((status) => status.key !== key);
        validateStatusConfigs(nextStatuses);
        const updatedTeam = teamStore.updateTeam(targetTeamId, { statuses: nextStatuses });
        if (!updatedTeam) return `Team not found: ${targetTeamId}`;

        emit("teamChange", { action: "updated", team: updatedTeam });
        return `Task status deleted for team "${updatedTeam.name}": ${key}`;
      } catch (err) {
        return `Failed to delete task status: ${err instanceof Error ? err.message : err}`;
      }
    },
  });

  const orchestratorUpdate = tool({
    description:
      "Update a team's orchestrator configuration (model, identity, prompt template, tools, etc.). If no orchestrator exists yet, one will be created. Defaults to the default team if no teamId is provided.",
    inputSchema: z.object({
      teamId: z.string().optional().describe("Team ID to update (defaults to the default team)"),
      name: z.string().optional().describe("Orchestrator name"),
      model: z.string().optional().describe("Model string (required when creating a new orchestrator)"),
      identity: z.string().optional().describe("System prompt / identity"),
      templateId: z.string().optional().describe("Prompt template ID to use instead of inline identity (pass empty string to unlink)"),
      tools: z.array(z.string()).optional().describe("List of tool names"),
      maxSteps: z.number().optional().describe("Max inference steps"),
      contextWindow: z.number().optional().describe("Context window size"),
    }),
    execute: async ({ teamId, name, model, identity, templateId, tools, maxSteps, contextWindow }) => {
      try {
        const { targetTeamId, scopeError } = resolveTargetTeamId(teamId);
        if (scopeError) return scopeError;
        const team = teamStore.getTeamById(targetTeamId);
        if (!team) return `Team not found: ${targetTeamId}`;
        const templateErr = validateTemplate(templateId);
        if (templateErr) return templateErr;
        const resolvedTemplateId = templateId === "" ? null : templateId;
        const agents = teamStore.listAgentsByTeam(targetTeamId);
        const orchestrator = agents.find((a) => a.role === "orchestrator");
        if (orchestrator) {
          const agent = teamStore.updateAgent(orchestrator.id, {
            name, model, identity, templateId: resolvedTemplateId,
            tools, maxSteps, contextWindow,
          });
          if (!agent) return `Failed to update orchestrator`;
          emit("teamChange", { action: "agentUpdated", agent });
          return `Orchestrator updated: "${agent.name}" (id: ${agent.id})`;
        }
        // No orchestrator exists — create one (model is required)
        if (!model) return "model is required when creating a new orchestrator";
        const agent = teamStore.createAgent(targetTeamId, {
          name: name ?? team.name,
          role: "orchestrator",
          model,
          identity,
          templateId: resolvedTemplateId,
          tools,
          maxSteps,
          contextWindow,
        });
        emit("teamChange", { action: "agentCreated", agent });
        return `Orchestrator created: "${agent.name}" (id: ${agent.id})`;
      } catch (err) {
        return `Failed to update orchestrator: ${err instanceof Error ? err.message : err}`;
      }
    },
  });

  const workerCreate = tool({
    description:
      "Add a worker agent to a team. Workers can be delegated tasks by the orchestrator. Defaults to the default team if no teamId is provided.",
    inputSchema: z.object({
      teamId: z.string().optional().describe("Team ID to add the worker to (defaults to the default team)"),
      name: z.string().describe("Worker name (unique within the team)"),
      model: z.string().describe("Model string (e.g. 'anthropic:claude-sonnet-4-20250514')"),
      identity: z.string().optional().describe("System prompt / identity for the worker"),
      templateId: z.string().optional().describe("Prompt template ID to use instead of inline identity"),
      tools: z.array(z.string()).optional().describe("List of tool names to enable"),
      maxSteps: z.number().optional().describe("Max inference steps per run"),
      timeout: z.number().optional().describe("Timeout in seconds for delegated tasks"),
    }),
    execute: async ({ teamId, name, model, identity, templateId, tools, maxSteps, timeout }) => {
      try {
        const { targetTeamId, scopeError } = resolveTargetTeamId(teamId);
        if (scopeError) return scopeError;
        const templateErr = validateTemplate(templateId);
        if (templateErr) return templateErr;
        const resolvedTemplateId = templateId === "" ? null : templateId;
        const agent = teamStore.createAgent(targetTeamId, {
          name,
          role: "worker",
          model,
          identity,
          templateId: resolvedTemplateId,
          tools,
          maxSteps,
          timeout,
        });
        emit("teamChange", { action: "agentCreated", agent });
        return `Worker created: "${agent.name}" (id: ${agent.id})`;
      } catch (err) {
        return `Failed to create worker: ${err instanceof Error ? err.message : err}`;
      }
    },
  });

  const workerUpdate = tool({
    description:
      "Update a worker's configuration (name, model, identity, tools, etc.).",
    inputSchema: z.object({
      id: z.string().describe("Agent ID to update"),
      name: z.string().optional().describe("New worker name"),
      model: z.string().optional().describe("New model string"),
      identity: z.string().optional().describe("New system prompt / identity"),
      templateId: z.string().optional().describe("Prompt template ID to use instead of inline identity (pass empty string to unlink)"),
      tools: z.array(z.string()).optional().describe("New list of tool names"),
      maxSteps: z.number().optional().describe("New max inference steps"),
      timeout: z.number().optional().describe("New timeout in seconds"),
    }),
    execute: async ({ id, name, model, identity, templateId, tools, maxSteps, timeout }) => {
      try {
        const existing = teamStore.getAgentById(id);
        if (!existing) return `Agent not found: ${id}`;
        if (!isAgentInScope(existing.teamId)) return `Agent not found: ${id}`;
        if (existing.role === "orchestrator") {
          return "Cannot modify an orchestrator via worker_update. Use orchestrator_update instead.";
        }
        const templateErr = validateTemplate(templateId);
        if (templateErr) return templateErr;
        const resolvedTemplateId = templateId === "" ? null : templateId;
        const agent = teamStore.updateAgent(id, { name, model, identity, templateId: resolvedTemplateId, tools, maxSteps, timeout });
        if (!agent) return `Agent not found: ${id}`;
        emit("teamChange", { action: "agentUpdated", agent });
        return `Worker updated: "${agent.name}" (id: ${agent.id})`;
      } catch (err) {
        return `Failed to update worker: ${err instanceof Error ? err.message : err}`;
      }
    },
  });

  const workerDelete = tool({
    description: "Remove a worker from the team. This cannot be undone.",
    inputSchema: z.object({
      id: z.string().describe("Agent ID to delete"),
    }),
    execute: async ({ id }) => {
      try {
        const existing = teamStore.getAgentById(id);
        if (!existing) return `Agent not found: ${id}`;
        if (!isAgentInScope(existing.teamId)) return `Agent not found: ${id}`;
        if (existing.role === "orchestrator") {
          return "Cannot delete an orchestrator via worker_delete. Orchestrators are tied to their team's lifecycle.";
        }
        const deleted = teamStore.deleteAgent(id);
        if (!deleted) return `Agent not found: ${id}`;
        emit("teamChange", { action: "agentDeleted", id });
        return `Worker deleted: ${id}`;
      } catch (err) {
        return `Failed to delete worker: ${err instanceof Error ? err.message : err}`;
      }
    },
  });

  const allTools: ToolSet = {
    team_list: teamList,
    team_create: teamCreate,
    team_update: teamUpdate,
    team_status_list: teamStatusList,
    team_status_get: teamStatusGet,
    team_status_add: teamStatusAdd,
    team_status_update: teamStatusUpdate,
    team_status_delete: teamStatusDelete,
    orchestrator_update: orchestratorUpdate,
    worker_create: workerCreate,
    worker_update: workerUpdate,
    worker_delete: workerDelete,
  };

  if (!enabledTools) return allTools;

  const filteredTools: ToolSet = {};
  for (const toolName of enabledTools) {
    const selected = allTools[toolName];
    if (selected) filteredTools[toolName] = selected;
  }
  return filteredTools;
}

/**
 * Worker CRUD-only toolset for a single team orchestrator.
 * Exposes worker_create/update/delete and hard-scopes all operations to `teamId`.
 */
export function createScopedWorkerManagementTools(
  teamStore: TeamStore,
  teamId: string,
  promptTemplateStore?: PromptTemplateStore,
): ToolSet {
  return createTeamManagementTools(teamStore, teamId, promptTemplateStore, {
    scopeTeamId: teamId,
    enabledTools: TEAM_WORKER_CRUD_TOOL_NAMES,
  });
}
