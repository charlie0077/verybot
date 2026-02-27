import { randomUUID } from "crypto";
import { logger } from "../logger.js";

export interface ConnectedChannel {
  channelType: string;
  channelId: string;
  send: (text: string) => Promise<void>;
}

/**
 * In-memory registry tracking which channels are connected to which team's scheduler.
 * Multiple channels (web UI, Telegram, etc.) can connect simultaneously.
 */
export class ConnectedChannelRegistry {
  /** Map<teamId, Map<connectionKey, ConnectedChannel>> */
  private channels = new Map<string, Map<string, ConnectedChannel>>();

  /** Register a channel connection. Returns a unique connection key for later disconnect. */
  connect(teamId: string, channel: ConnectedChannel): string {
    const key = randomUUID();
    let teamMap = this.channels.get(teamId);
    if (!teamMap) {
      teamMap = new Map();
      this.channels.set(teamId, teamMap);
    }
    teamMap.set(key, channel);
    logger.info(`[scheduler] Channel connected: ${channel.channelType}:${channel.channelId} → team ${teamId} (key: ${key.slice(0, 8)})`);
    return key;
  }

  /** Unregister a channel connection. */
  disconnect(teamId: string, key: string): void {
    const teamMap = this.channels.get(teamId);
    if (!teamMap) return;
    teamMap.delete(key);
    if (teamMap.size === 0) this.channels.delete(teamId);
    logger.info(`[scheduler] Channel disconnected: team ${teamId} (key: ${key.slice(0, 8)})`);
  }

  /** Get all connected channels for a team. */
  getAll(teamId: string): ConnectedChannel[] {
    const teamMap = this.channels.get(teamId);
    if (!teamMap) return [];
    return [...teamMap.values()];
  }

  /**
   * Broadcast a message to all connected channels for a team.
   * `excludeKey` skips a specific connection (e.g., the sender that already has the reply).
   */
  async broadcastToTeam(teamId: string, text: string, excludeKey?: string): Promise<void> {
    const teamMap = this.channels.get(teamId);
    if (!teamMap) return;

    const sends: Promise<void>[] = [];
    for (const [key, channel] of teamMap) {
      if (key === excludeKey) continue;
      sends.push(
        channel.send(text).catch((err) => {
          logger.warn(`[scheduler] Broadcast to ${channel.channelType}:${channel.channelId} failed: ${err instanceof Error ? err.message : err}`);
        }),
      );
    }
    await Promise.all(sends);
  }
}
