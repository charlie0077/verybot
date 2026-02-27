import { App } from "@slack/bolt";
import type { Channel, ChannelMessage, MessageHandler } from "../types.js";
import { logger } from "../../logger.js";
import { markdownToSlackMrkdwnChunks, escapeSlackMrkdwn, SLACK_TEXT_LIMIT } from "./markdown.js";
import type { MarkdownTableMode } from "../../markdown/ir.js";
import { CommandRouter, type CommandResult, type CommandPart } from "../commands.js";

/** Emoji added while the bot is processing a message. */
const TYPING_EMOJI = "eyes";

export interface SlackSchedulerOpts {
  /** Register a Slack channel as a connected scheduler channel. */
  connectScheduler: (teamId: string, channelId: string, sendFn: (text: string) => Promise<void>) => string;
  /** Unregister a Slack channel from the scheduler. */
  disconnectScheduler: (teamId: string, key: string) => void;
}

/** Callback that resolves the current table mode from config at send time. */
export type ResolveTableMode = () => MarkdownTableMode;

export interface CreateSlackChannelOpts {
  botToken: string;
  appToken: string;
  onMessage: MessageHandler;
  onClear?: (channelType: string, channelId: string, teamId?: string) => Promise<void>;
  onLearn?: (
    channelType: string,
    channelId: string,
    topic?: string,
    teamId?: string,
  ) => Promise<{
    topic?: string;
    extracted: number;
    saved: number;
    skipped: number;
    savedFacts: string[];
  }>;
  onRemember?: (
    channelType: string,
    channelId: string,
    fact: string,
    teamId?: string,
  ) => Promise<{ saved: boolean; fact: string }>;
  /** List available teams for the /team command. */
  listTeams?: () => { id: string; name: string }[];
  /** Fallback team when no active team is set for a channel. */
  defaultTeamId?: string;
  schedulerOpts?: SlackSchedulerOpts;
  resolveTableMode?: ResolveTableMode;
}

/** Send chunked Slack mrkdwn to a channel. Optionally in-thread via threadTs. */
async function sendMrkdwnChunks(
  app: App,
  channelId: string,
  text: string,
  resolveTableMode: ResolveTableMode,
  threadTs?: string,
) {
  const tableMode = resolveTableMode();
  const chunks = markdownToSlackMrkdwnChunks(text, SLACK_TEXT_LIMIT, { tableMode });
  if (chunks.length === 0 && text) {
    await app.client.chat.postMessage({ channel: channelId, text, thread_ts: threadTs });
    return;
  }
  for (const chunk of chunks) {
    await app.client.chat.postMessage({ channel: channelId, text: chunk, thread_ts: threadTs });
  }
}

/** Strip the bot mention prefix (e.g. `<@U12345>`) from message text. */
function stripBotMention(text: string, botUserId: string): string {
  const prefix = `<@${botUserId}>`;
  const trimmed = text.trimStart();
  if (trimmed.startsWith(prefix)) {
    return trimmed.slice(prefix.length).trim();
  }
  return text.trim();
}

export function createSlackChannel(opts: CreateSlackChannelOpts): Channel {
  const {
    botToken,
    appToken,
    onMessage,
    onClear,
    onLearn,
    onRemember,
    listTeams,
    defaultTeamId,
    schedulerOpts,
    resolveTableMode = () => "code",
  } = opts;

  const app = new App({
    token: botToken,
    appToken,
    socketMode: true,
  });

  const commands = new CommandRouter({ onClear, onLearn, onRemember, listTeams, defaultTeamId });

  /** Map<channelId, { teamId, connectionKey }> for active scheduler connections. */
  const schedulerConnections = new Map<string, { teamId: string; connectionKey: string }>();
  /** Track active typing-proxy reaction timestamps per channel to avoid duplicate removals. */
  const typingReactionTs = new Map<string, Set<string>>();
  /**
   * Track thread context per channelId so replies stay in-thread.
   * Note: in channels with concurrent @mentions, the latest message wins.
   * DMs are safe since each DM conversation has a unique channelId.
   */
  const threadMap = new Map<string, { threadTs: string; messageTs: string }>();

  /** Format a CommandResult using Slack mrkdwn syntax. */
  function formatSlackResult(result: CommandResult): string {
    return result.parts
      .map((p: CommandPart) => {
        if (typeof p === "string") return escapeSlackMrkdwn(p);
        if ("bold" in p) return `*${escapeSlackMrkdwn(p.bold)}*`;
        return `\`${p.code}\``;
      })
      .join("");
  }

  /**
   * Handle text-based commands (e.g. "/clear", "/team foo").
   * Returns true if the message was consumed as a command.
   */
  async function handleTextCommand(text: string, channelId: string): Promise<boolean> {
    const result = await commands.handle("slack", channelId, text);
    if (!result) return false;
    await app.client.chat.postMessage({ channel: channelId, text: formatSlackResult(result) });
    return true;
  }

  /** Add a reaction as typing proxy; silently ignore failures. */
  async function addTypingReaction(channelId: string, ts: string) {
    let activeTs = typingReactionTs.get(channelId);
    if (!activeTs) {
      activeTs = new Set<string>();
      typingReactionTs.set(channelId, activeTs);
    }
    activeTs.add(ts);
    try {
      await app.client.reactions.add({ channel: channelId, timestamp: ts, name: TYPING_EMOJI });
    } catch {
      // Reaction may already exist or bot lacks permission — safe to ignore
    }
  }

  /** Remove typing reaction; silently ignore failures. */
  async function removeTypingReaction(channelId: string, ts: string) {
    const activeTs = typingReactionTs.get(channelId);
    if (!activeTs?.has(ts)) return;
    activeTs.delete(ts);
    if (activeTs.size === 0) typingReactionTs.delete(channelId);
    try {
      await app.client.reactions.remove({ channel: channelId, timestamp: ts, name: TYPING_EMOJI });
    } catch {
      // Safe to ignore
    }
  }

  const channel: Channel = {
    name: "slack",
    start: async () => {
      // --- @mention events (channels/groups) ---
      app.event("app_mention", async ({ event, context }) => {
        const channelId = event.channel;
        const userId = event.user ?? "unknown";
        const botUserId = context.botUserId ?? "";
        const rawText = event.text ?? "";
        const text = stripBotMention(rawText, botUserId);
        const ts = event.ts;
        const threadTs = event.thread_ts ?? ts;

        if (!text) return;
        if (await handleTextCommand(text, channelId)) return;

        logger.info(`[slack] mention from ${userId} in ${channelId}`);
        threadMap.set(channelId, { threadTs, messageTs: ts });
        await addTypingReaction(channelId, ts);

        try {
          await onMessage(
            {
              channelType: "slack",
              channelId,
              userId,
              text,
              teamId: commands.resolveTeamId(channelId),
            },
            channel,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error(`[slack] error handling mention in ${channelId}: ${msg}`);
        } finally {
          await removeTypingReaction(channelId, ts);
        }
      });

      // --- DM events ---
      app.event("message", async ({ event, context }) => {
        // Only handle direct messages (im channel type)
        // Skip bot messages, changed messages, etc.
        if (!("channel_type" in event) || event.channel_type !== "im") return;
        if ("subtype" in event && event.subtype) return;
        if (!("user" in event) || !event.user) return;
        if (!("text" in event) || !event.text) return;
        // Ignore messages from the bot itself
        if (event.user === context.botUserId) return;

        const channelId = event.channel;
        const userId = event.user;
        const botUserId = context.botUserId ?? "";
        // Strip bot mention so "@bot /clear" is matched as "/clear"
        const text = stripBotMention(event.text, botUserId);
        const ts = event.ts;
        const threadTs = ("thread_ts" in event ? event.thread_ts : undefined) ?? ts;
        if (!text) return;

        if (await handleTextCommand(text, channelId)) return;

        logger.info(`[slack] DM from ${userId}`);
        threadMap.set(channelId, { threadTs, messageTs: ts });
        await addTypingReaction(channelId, ts);

        try {
          await onMessage(
            {
              channelType: "slack",
              channelId,
              userId,
              text,
              teamId: commands.resolveTeamId(channelId),
            },
            channel,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error(`[slack] error handling DM from ${userId}: ${msg}`);
        } finally {
          await removeTypingReaction(channelId, ts);
        }
      });

      await app.start();
      logger.info("[slack] connected via Socket Mode");
    },

    stop: async () => {
      for (const [, conn] of schedulerConnections) {
        schedulerOpts?.disconnectScheduler(conn.teamId, conn.connectionKey);
      }
      schedulerConnections.clear();
      await app.stop();
      logger.info("[slack] disconnected");
    },

    send: async (channelId, text) => {
      const entry = threadMap.get(channelId);
      await sendMrkdwnChunks(app, channelId, text, resolveTableMode, entry?.threadTs);
      if (entry) {
        await removeTypingReaction(channelId, entry.messageTs);
      }
    },

    readHistory: async (channelId, limit = 20, threadTs?) => {
      logger.info(`[slack] readHistory channel=${channelId} limit=${limit} threadTs=${threadTs ?? "none"}`);

      let raw;
      if (threadTs) {
        const result = await app.client.conversations.replies({
          channel: channelId,
          ts: threadTs,
          limit,
        });
        raw = result.messages ?? [];
      } else {
        const result = await app.client.conversations.history({
          channel: channelId,
          limit,
        });
        // conversations.history returns newest-first, reverse for chronological
        raw = (result.messages ?? []).reverse();
      }

      logger.info(`[slack] readHistory returned ${raw.length} messages for ${channelId}`);
      return raw.map((msg): ChannelMessage => ({
        user: msg.user ?? "bot",
        text: msg.text ?? "",
        ts: msg.ts ?? "",
      }));
    },
  };

  return channel;
}
