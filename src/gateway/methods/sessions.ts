import type { Agent } from "../../brain/agent.js";
import { parseSessionKey } from "../../brain/session-key.js";
import { logger } from "../../logger.js";

const DEFAULT_KEEP_LATEST_SESSIONS = 300;

interface ListSessionsParams {
  limit?: number;
  offset?: number;
  teamId?: string;
}

interface ClearOldSessionsParams {
  keepLatest?: number;
  teamId?: string;
}

function toOptionalPositiveInteger(value: unknown, fieldName: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
  return value;
}

function toNonNegativeInteger(value: unknown, fieldName: string, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative integer`);
  }
  return value;
}

function toOptionalString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${fieldName} must be a string`);
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveSessionTeamId(session: { key: string; teamId?: string }): string | undefined {
  if (session.teamId) return session.teamId;
  return parseSessionKey(session.key).teamId;
}

export function sessionMethods(getAgent: () => Agent) {
  return {
    "sessions.list": async (params?: ListSessionsParams) => {
      const agent = getAgent();
      const allSessions = agent.getStore().list();
      const limit = toOptionalPositiveInteger(params?.limit, "limit");
      const offset = toNonNegativeInteger(params?.offset, "offset", 0);
      const teamId = toOptionalString(params?.teamId, "teamId");
      const sessions = teamId
        ? allSessions.filter((session) => resolveSessionTeamId(session) === teamId)
        : allSessions;
      const pagedSessions = limit === undefined
        ? sessions.slice(offset)
        : sessions.slice(offset, offset + limit);

      // Enrich sessions with team name + color from the team store
      const teams = agent.getTeams();
      const teamById = new Map(teams.map((t) => [t.id, t]));
      const enriched = pagedSessions.map((s) => {
        const sessionTeamId = resolveSessionTeamId(s);
        const team = sessionTeamId ? teamById.get(sessionTeamId) : undefined;
        if (!team) return s;
        return {
          ...s,
          ...(sessionTeamId && !s.teamId && { teamId: sessionTeamId }),
          ...(team.name && { teamName: team.name }),
          ...(team.color && { teamColor: team.color }),
        };
      });

      const nextOffset = offset + enriched.length;
      const hasMore = nextOffset < sessions.length;
      return {
        sessions: enriched,
        total: sessions.length,
        hasMore,
        nextOffset: hasMore ? nextOffset : null,
        ts: Date.now(),
      };
    },

    "sessions.get": async (params: { sessionKey: string }) => {
      if (!params?.sessionKey || typeof params.sessionKey !== "string") {
        throw new Error("sessionKey is required and must be a string");
      }
      const session = await getAgent().getStore().load(params.sessionKey);
      if (!session) return { messages: [] };
      const messages = session.getMessages().map((m) => ({
        role: m.role,
        content: m.content,
      }));
      return { messages };
    },

    "sessions.rename": async (params: { sessionKey: string; title: string }) => {
      if (!params?.sessionKey || typeof params.sessionKey !== "string") {
        throw new Error("sessionKey is required and must be a string");
      }
      if (!params?.title || typeof params.title !== "string") {
        throw new Error("title is required and must be a string");
      }
      const ok = getAgent().getStore().rename(params.sessionKey, params.title);
      if (!ok) return { status: "not_found" };
      logger.info(`[${params.sessionKey}] Session renamed to: ${params.title}`);
      return { status: "ok" };
    },

    "sessions.clear": async (params: { sessionKey: string }) => {
      logger.info(`[${params.sessionKey}] Session clear requested`);
      await getAgent().clearSession(params.sessionKey);
      return { status: "ok" };
    },

    "sessions.clearOld": async (params?: ClearOldSessionsParams) => {
      const keepLatest = toNonNegativeInteger(params?.keepLatest, "keepLatest", DEFAULT_KEEP_LATEST_SESSIONS);
      const teamId = toOptionalString(params?.teamId, "teamId");
      logger.info(`[sessions] Clear old requested (keepLatest=${keepLatest}${teamId ? `, teamId=${teamId}` : ""})`);
      const cleared = await getAgent().clearOldSessions(keepLatest, teamId);
      return { status: "ok", keepLatest, cleared };
    },
  };
}
