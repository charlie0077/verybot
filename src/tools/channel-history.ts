import { tool, type Tool } from "ai";
import { z } from "zod";
import type { ChannelManager } from "../channels/manager.js";
import { logger } from "../logger.js";

/** Default number of messages to fetch. */
const DEFAULT_LIMIT = 20;

/**
 * Create a read_channel_history tool that lets the LLM fetch recent messages
 * from the current messaging channel (Slack, etc.) on demand.
 *
 * The channelId is resolved fresh at execution time from a callback
 * to avoid stale closures.
 */
export function createChannelHistoryTool(
  channelManager: ChannelManager,
  channelType: string,
  resolveChannelId: () => string,
): Tool | null {
  const ch = channelManager.get(channelType);
  if (!ch?.readHistory) return null;

  return tool({
    description:
      "Read recent messages from the current chat channel or thread. " +
      "Use this when the user references prior conversation, asks what was discussed, " +
      "or needs context about the channel's recent messages. " +
      "Returns messages in chronological order.",
    inputSchema: z.object({
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Number of recent messages to fetch (default 20, max 50)"),
    }),
    execute: async ({ limit }) => {
      const channelId = resolveChannelId();
      logger.info(`[channel-history] Reading ${channelType}/${channelId} limit=${limit ?? DEFAULT_LIMIT}`);
      const messages = await ch.readHistory!(channelId, limit ?? DEFAULT_LIMIT);
      if (messages.length === 0) return `No messages found in channel ${channelId}.`;
      const formatted = messages
        .map((m) => `<@${m.user}>: ${m.text}`)
        .join("\n");
      return `[${channelType} channel ${channelId} — ${messages.length} messages]\n${formatted}`;
    },
  });
}
