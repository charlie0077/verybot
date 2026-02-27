import { randomUUID } from "crypto";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { Cron } from "croner";
import type { ScheduleStore } from "../scheduler/store.js";
import type { ScheduleType } from "../scheduler/types.js";

/**
 * Create schedule management tools scoped to a team.
 * These let the LLM create, list, delete, pause, resume schedules
 * and set the team's timezone.
 */
export function createScheduleTools(
  store: ScheduleStore,
  teamId: string,
  availableIntegrations: string[],
): ToolSet {
  const integrationsList = availableIntegrations.length > 0
    ? `Available integrations: ${availableIntegrations.join(", ")}.`
    : "No integrations available.";

  const createSchedule = tool({
    description:
      `Create a scheduled task. Create IMMEDIATELY when user asks — do NOT ask for confirmation. ` +
      `One-shot: provide runAt (ISO 8601). Recurring: provide cron (e.g. "0 9 * * *"). ` +
      `Convert relative times to absolute timestamps using current time. ` +
      `${integrationsList}`,
    inputSchema: z.object({
      prompt: z.string().describe(
        "The exact message or instruction to execute when this task fires. " +
        "For reminders: write the actual reminder text the user should see (e.g. 'Time to call Sarah!' not 'Reminder from Assistant'). " +
        "For data tasks: write a clear instruction (e.g. 'Check BTC price and report current value')."
      ),
      type: z.enum(["one_shot", "recurring"]).describe("one_shot for reminders, recurring for repeating tasks"),
      cron: z.string().optional().describe("Cron expression for recurring tasks (e.g. '0 9 * * *')"),
      runAt: z.string().optional().describe("ISO 8601 timestamp for one-shot tasks (e.g. '2026-02-08T15:30:00')"),
      timezone: z.string().optional().describe("IANA timezone (e.g. 'America/New_York'). Uses saved team timezone if omitted."),
      integrations: z.string().optional().describe("Comma-separated integration names to enable for this task"),
      conditional: z.boolean().optional().describe("If true, the agent can skip delivery if nothing noteworthy happened"),
    }),
    execute: async (params) => {
      // Resolve timezone: user param > saved setting > UTC default
      const tz = params.timezone || store.getTimezone(teamId) || "UTC";

      // Validate timezone
      try {
        Intl.DateTimeFormat(undefined, { timeZone: tz });
      } catch {
        return `Invalid timezone "${tz}". Use IANA format like "America/New_York" or "Asia/Shanghai".`;
      }

      const type: ScheduleType = params.type;

      // Validate cron for recurring
      if (type === "recurring") {
        if (!params.cron) {
          return "Recurring schedules require a cron expression.";
        }
        try {
          new Cron(params.cron);
        } catch (err) {
          return `Invalid cron expression "${params.cron}": ${err instanceof Error ? err.message : err}`;
        }
      }

      // Validate runAt for one-shot
      if (type === "one_shot") {
        if (!params.runAt) {
          return "One-shot schedules require a runAt timestamp.";
        }
        const runDate = new Date(params.runAt);
        if (isNaN(runDate.getTime())) {
          return `Invalid timestamp "${params.runAt}". Use ISO 8601 format.`;
        }
        if (runDate.getTime() <= Date.now()) {
          return `The time "${params.runAt}" is in the past. Provide a future time.`;
        }
      }

      // Compute nextRun
      let nextRun: string | null = null;
      if (type === "one_shot" && params.runAt) {
        nextRun = new Date(params.runAt).toISOString();
      } else if (type === "recurring" && params.cron) {
        try {
          const job = new Cron(params.cron, { timezone: tz });
          const next = job.nextRun();
          nextRun = next ? next.toISOString() : null;
        } catch {
          return "Failed to compute next run time from cron expression.";
        }
      }

      const now = new Date().toISOString();
      const id = randomUUID();

      store.create({
        id,
        teamId,
        prompt: params.prompt,
        type,
        cron: params.cron ?? null,
        runAt: params.runAt ?? null,
        timezone: tz,
        integrations: params.integrations ?? "",
        conditional: params.conditional ?? false,
        status: "active",
        nextRun,
        lastRun: null,
        failCount: 0,
        createdAt: now,
        updatedAt: now,
      });

      const nextRunFormatted = nextRun
        ? new Date(nextRun).toLocaleString("en-US", { timeZone: tz })
        : "unknown";

      return `Schedule created (${type}). ID: ${id}\nNext run: ${nextRunFormatted} (${tz})`;
    },
  });

  const listSchedules = tool({
    description: "List all scheduled tasks for the current team.",
    inputSchema: z.object({
      status: z.enum(["active", "paused", "completed", "failed"]).optional()
        .describe("Filter by status. Omit to show all."),
    }),
    execute: async ({ status }) => {
      const schedules = store.listByTeam(teamId, status);
      if (schedules.length === 0) {
        return status ? `No ${status} schedules found.` : "No schedules found.";
      }

      const tz = store.getTimezone(teamId) ?? "UTC";
      const lines = schedules.map((s) => {
        const nextStr = s.nextRun
          ? new Date(s.nextRun).toLocaleString("en-US", { timeZone: tz })
          : "—";
        const typeStr = s.type === "recurring" ? `recurring (${s.cron})` : "one-shot";
        const condStr = s.conditional ? " [conditional]" : "";
        return `- **${s.id.slice(0, 8)}** [${s.status}] ${typeStr}${condStr}\n  "${s.prompt.slice(0, 80)}"\n  Next: ${nextStr}`;
      });

      return lines.join("\n\n");
    },
  });

  const deleteSchedule = tool({
    description: "Delete a scheduled task by its ID.",
    inputSchema: z.object({
      id: z.string().describe("Schedule ID (full or first 8 chars)"),
    }),
    execute: async ({ id }) => {
      const schedule = resolveScheduleId(store, teamId, id);
      if (!schedule) return `Schedule "${id}" not found or does not belong to this team.`;

      store.delete(schedule.id);
      return `Schedule "${schedule.id.slice(0, 8)}" deleted.`;
    },
  });

  const pauseSchedule = tool({
    description: "Pause an active scheduled task. It will not fire until resumed.",
    inputSchema: z.object({
      id: z.string().describe("Schedule ID (full or first 8 chars)"),
    }),
    execute: async ({ id }) => {
      const schedule = resolveScheduleId(store, teamId, id);
      if (!schedule) return `Schedule "${id}" not found or does not belong to this team.`;
      if (schedule.status !== "active") return `Schedule is not active (status: ${schedule.status}).`;

      store.update(schedule.id, { status: "paused" });
      return `Schedule "${schedule.id.slice(0, 8)}" paused.`;
    },
  });

  const resumeSchedule = tool({
    description: "Resume a paused scheduled task.",
    inputSchema: z.object({
      id: z.string().describe("Schedule ID (full or first 8 chars)"),
    }),
    execute: async ({ id }) => {
      const schedule = resolveScheduleId(store, teamId, id);
      if (!schedule) return `Schedule "${id}" not found or does not belong to this team.`;
      if (schedule.status !== "paused") return `Schedule is not paused (status: ${schedule.status}).`;

      // Recompute next run
      let nextRun: string | null = null;
      if (schedule.type === "recurring" && schedule.cron) {
        nextRun = store.computeNextRun(schedule);
      } else if (schedule.type === "one_shot" && schedule.runAt) {
        // For one-shots, use original runAt if still in the future
        const runDate = new Date(schedule.runAt);
        nextRun = runDate.getTime() > Date.now() ? runDate.toISOString() : new Date().toISOString();
      }

      store.update(schedule.id, { status: "active", nextRun });
      return `Schedule "${schedule.id.slice(0, 8)}" resumed. Next run: ${nextRun ?? "now"}`;
    },
  });

  const setTimezone = tool({
    description:
      `Set your timezone for scheduled tasks. Use IANA timezone names like "America/New_York", "Asia/Shanghai", "Europe/London".`,
    inputSchema: z.object({
      timezone: z.string().describe('IANA timezone name (e.g. "America/New_York")'),
    }),
    execute: async ({ timezone }) => {
      try {
        Intl.DateTimeFormat(undefined, { timeZone: timezone });
      } catch {
        return `Invalid timezone "${timezone}". Use IANA format like "America/New_York" or "Asia/Shanghai".`;
      }

      store.setTimezone(teamId, timezone);
      return `Timezone set to "${timezone}".`;
    },
  });

  return {
    create_schedule: createSchedule,
    list_schedules: listSchedules,
    delete_schedule: deleteSchedule,
    pause_schedule: pauseSchedule,
    resume_schedule: resumeSchedule,
    set_timezone: setTimezone,
  };
}

/** Resolve a schedule ID (full or short) that belongs to the given team. */
function resolveScheduleId(
  store: ScheduleStore,
  teamId: string,
  id: string,
) {
  // Try exact match first
  const exact = store.getById(id);
  if (exact && exact.teamId === teamId) return exact;

  // Try short ID prefix match
  const all = store.listByTeam(teamId);
  const matches = all.filter((s) => s.id.startsWith(id));
  if (matches.length === 1) return matches[0];

  return null;
}
