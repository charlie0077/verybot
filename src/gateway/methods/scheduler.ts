import type { Agent } from "../../brain/agent.js";
import type { ScheduleStore } from "../../scheduler/store.js";
import type { ConnectedChannelRegistry } from "../../scheduler/connected-channels.js";
import type { ScheduleStatus } from "../../scheduler/types.js";
import type { RpcContext } from "../rpc.js";
import { broadcast, onClientClose } from "../broadcast.js";

const VALID_STATUSES = new Set<ScheduleStatus>(["active", "paused", "completed", "failed"]);

/** Validate that `teamId` belongs to a real team. */
function validateTeamId(agent: Agent, teamId: string): void {
  if (!teamId) throw new Error("Missing teamId");
  const teams = agent.getTeams();
  if (!teams.some((t) => t.id === teamId)) {
    throw new Error(`Unknown team: "${teamId}"`);
  }
}

export function schedulerMethods(
  getAgent: () => Agent,
  getScheduleStore: () => ScheduleStore,
  getConnectedChannels: () => ConnectedChannelRegistry,
  ctx?: RpcContext,
) {
  return {
    /** Connect a WS client to a team's scheduler. Returns session history + connection key. */
    "scheduler.connect": async (params: { teamId: string }) => {
      const { teamId } = params;
      validateTeamId(getAgent(), teamId);

      const connectedChannels = getConnectedChannels();

      // Register this WS as a connected channel — send fn broadcasts via WS events
      const connectionKey = connectedChannels.connect(teamId, {
        channelType: "gateway",
        channelId: `ws:${teamId}`,
        send: async (text: string) => {
          broadcast("schedulerMessage", { teamId, role: "assistant", content: text });
        },
      });

      // Auto-disconnect when the WS closes (prevents stale entries)
      if (ctx?.ws) {
        onClientClose(ctx.ws, () => {
          connectedChannels.disconnect(teamId, connectionKey);
        });
      }

      // Return existing session history
      const session = getAgent().getSchedulerSession(teamId);
      const messages = session?.getMessages() ?? [];

      return { connectionKey, messages };
    },

    /** Disconnect a WS client from a team's scheduler. */
    "scheduler.disconnect": async (params: { teamId: string; connectionKey: string }) => {
      const { teamId, connectionKey } = params;
      if (!teamId || !connectionKey) throw new Error("Missing teamId or connectionKey");

      getConnectedChannels().disconnect(teamId, connectionKey);
      return { status: "ok" };
    },

    /** Send a message to the team's scheduler session. */
    "scheduler.send": async (params: { teamId: string; message: string }) => {
      const { teamId, message } = params;
      if (!message) throw new Error("Missing message");
      validateTeamId(getAgent(), teamId);

      // Broadcast user message to OTHER clients (sender already has it via optimistic UI)
      const excludeWs = ctx?.ws;
      broadcast("schedulerMessage", { teamId, role: "user", content: message, senderInfo: "Web UI" }, excludeWs);

      const reply = await getAgent().handleSchedulerMessage(teamId, message, "Web UI");

      // Broadcast reply to OTHER clients (sender gets it via RPC response)
      broadcast("schedulerMessage", { teamId, role: "assistant", content: reply }, excludeWs);

      return { status: "ok", reply };
    },

    /** Get scheduler session history for a team. */
    "scheduler.history": async (params: { teamId: string }) => {
      const { teamId } = params;
      validateTeamId(getAgent(), teamId);

      const session = getAgent().getSchedulerSession(teamId);
      return { messages: session?.getMessages() ?? [] };
    },

    /** List schedules for a team. */
    "scheduler.list": async (params: { teamId: string; status?: string }) => {
      const { teamId, status } = params;
      validateTeamId(getAgent(), teamId);

      if (status && !VALID_STATUSES.has(status as ScheduleStatus)) {
        throw new Error(`Invalid status: "${status}". Must be one of: active, paused, completed, failed`);
      }

      const store = getScheduleStore();
      const schedules = store.listByTeam(teamId, status as ScheduleStatus | undefined);
      return { schedules };
    },

    // --- Direct schedule CRUD (bypasses LLM) ---

    /** Pause an active schedule. */
    "scheduler.pause": async (params: { teamId: string; scheduleId: string }) => {
      const { teamId, scheduleId } = params;
      if (!scheduleId) throw new Error("Missing scheduleId");
      validateTeamId(getAgent(), teamId);

      const store = getScheduleStore();
      const schedule = store.getById(scheduleId);
      if (!schedule || schedule.teamId !== teamId) {
        throw new Error(`Schedule "${scheduleId}" not found for this team`);
      }
      if (schedule.status !== "active") {
        throw new Error(`Schedule is not active (status: ${schedule.status})`);
      }

      store.update(scheduleId, { status: "paused" });
      return { status: "ok" };
    },

    /** Resume a paused schedule. */
    "scheduler.resume": async (params: { teamId: string; scheduleId: string }) => {
      const { teamId, scheduleId } = params;
      if (!scheduleId) throw new Error("Missing scheduleId");
      validateTeamId(getAgent(), teamId);

      const store = getScheduleStore();
      const schedule = store.getById(scheduleId);
      if (!schedule || schedule.teamId !== teamId) {
        throw new Error(`Schedule "${scheduleId}" not found for this team`);
      }
      if (schedule.status !== "paused") {
        throw new Error(`Schedule is not paused (status: ${schedule.status})`);
      }

      const nextRun = store.computeNextRun(schedule);
      store.update(scheduleId, { status: "active", nextRun });
      return { status: "ok" };
    },

    /** Delete a schedule. */
    "scheduler.delete": async (params: { teamId: string; scheduleId: string }) => {
      const { teamId, scheduleId } = params;
      if (!scheduleId) throw new Error("Missing scheduleId");
      validateTeamId(getAgent(), teamId);

      const store = getScheduleStore();
      const schedule = store.getById(scheduleId);
      if (!schedule || schedule.teamId !== teamId) {
        throw new Error(`Schedule "${scheduleId}" not found for this team`);
      }

      store.delete(scheduleId);
      return { status: "ok" };
    },
  };
}
