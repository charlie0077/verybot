import { DEFAULT_TEAM_ID } from "../config/agent-config.js";

/**
 * Build a session key: `{teamId}:{channelType}:{channelId}`.
 */
export function buildSessionKey(teamId: string, channelType: string, channelId: string): string {
  return `${teamId}:${channelType}:${channelId}`;
}

/**
 * Extract a non-default teamId from a session key for memory scoping.
 * Returns undefined for the default team (global memory).
 */
export function deriveMemoryTeamId(sessionKey: string): string | undefined {
  const { teamId } = parseSessionKey(sessionKey);
  return teamId && teamId !== DEFAULT_TEAM_ID ? teamId : undefined;
}

export interface ParsedSessionKey {
  teamId?: string;
  channelType?: string;
  /** Agent name (for worker sessions only, extracted from key). */
  agentName?: string;
  isWorker: boolean;
}

/**
 * Parse a session key into its components.
 *
 * Standard key: `{teamId}:{channelType}:{channelId}`
 * Worker  key: `{teamId}:{parentChannel}:{channelId}:{agentName}:{timestamp}`
 */
export function parseSessionKey(key: string): ParsedSessionKey {
  const parts = key.split(":");
  // Worker keys have 5+ parts with a numeric timestamp at the end
  if (parts.length >= 5 && /^\d+$/.test(parts[parts.length - 1])) {
    return {
      isWorker: true,
      teamId: parts[0],
      channelType: "worker",
      agentName: parts[parts.length - 2],
    };
  }
  if (parts.length >= 3) {
    return {
      isWorker: false,
      teamId: parts[0],
      channelType: parts[1],
    };
  }
  return { isWorker: false };
}
