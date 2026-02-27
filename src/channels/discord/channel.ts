import { Client, GatewayIntentBits, Partials, Events } from "discord.js";
import type { Channel, MessageHandler } from "../types.js";
import { logger } from "../../logger.js";
import { markdownToDiscordChunks, escapeDiscord, DISCORD_TEXT_LIMIT } from "./markdown.js";
import type { MarkdownTableMode } from "../../markdown/ir.js";
import { CommandRouter, type CommandResult, type CommandPart } from "../commands.js";

/** Discord typing indicator expires after ~10s; refresh every 8s. */
const TYPING_INTERVAL_MS = 8000;

/** Callback that resolves the current table mode from config at send time. */
export type ResolveTableMode = () => MarkdownTableMode;

export interface CreateDiscordChannelOpts {
  token: string;
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
  resolveTableMode?: ResolveTableMode;
}

export function createDiscordChannel(opts: CreateDiscordChannelOpts): Channel {
  const {
    token,
    onMessage,
    onClear,
    onLearn,
    onRemember,
    listTeams,
    defaultTeamId,
    resolveTableMode = () => "code",
  } = opts;

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel],
  });

  const typingIntervals = new Map<string, ReturnType<typeof setInterval>>();
  const commands = new CommandRouter({ onClear, onLearn, onRemember, listTeams, defaultTeamId });

  /** Format a CommandResult using Discord markdown syntax. */
  function formatDiscordResult(result: CommandResult): string {
    return result.parts
      .map((p: CommandPart) => {
        if (typeof p === "string") return escapeDiscord(p);
        if ("bold" in p) return `**${escapeDiscord(p.bold)}**`;
        return `\`${p.code}\``;
      })
      .join("");
  }

  /**
   * Handle text-based commands (e.g. "/clear", "/team foo").
   * Returns the formatted response if the message was consumed, or null.
   */
  async function handleTextCommand(text: string, channelId: string): Promise<string | null> {
    try {
      const result = await commands.handle("discord", channelId, text);
      if (!result) return null;
      return formatDiscordResult(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[discord] command error: ${msg}`);
      return "Failed to process command. Please try again.";
    }
  }

  function startTyping(channelId: string) {
    stopTyping(channelId);
    const discordChannel = client.channels.cache.get(channelId);
    if (!discordChannel?.isTextBased() || !("sendTyping" in discordChannel)) return;

    // Send immediately, then refresh on interval
    discordChannel.sendTyping().catch((err) => logger.error(`[discord] typing error: ${err}`));
    const interval = setInterval(() => {
      discordChannel.sendTyping().catch((err) => logger.error(`[discord] typing interval error: ${err}`));
    }, TYPING_INTERVAL_MS);
    typingIntervals.set(channelId, interval);
  }

  function stopTyping(channelId: string) {
    const interval = typingIntervals.get(channelId);
    if (interval) {
      clearInterval(interval);
      typingIntervals.delete(channelId);
    }
  }

  /** Send chunked Discord markdown to a channel. */
  async function sendChunks(channelId: string, text: string) {
    const discordChannel = client.channels.cache.get(channelId);
    if (!discordChannel?.isTextBased() || !("send" in discordChannel)) {
      logger.error(`[discord] cannot send to channel ${channelId}: not a text channel`);
      return;
    }
    const tableMode = resolveTableMode();
    const chunks = markdownToDiscordChunks(text, DISCORD_TEXT_LIMIT, { tableMode });
    const noMentions = { allowedMentions: { parse: [] as const } };
    if (chunks.length === 0 && text) {
      await discordChannel.send({ content: text, ...noMentions });
      return;
    }
    for (const chunk of chunks) {
      await discordChannel.send({ content: chunk, ...noMentions });
    }
  }

  /** Strip the bot mention prefix (e.g. `<@123456>`) from message text. */
  function stripBotMention(text: string): string {
    const botId = client.user?.id;
    if (!botId) return text.trim();
    const mentionRegex = new RegExp(`^\\s*<@!?${botId}>\\s*`);
    return text.replace(mentionRegex, "").trim();
  }

  const channel: Channel = {
    name: "discord",

    start: async () => {
      client.on(Events.MessageCreate, async (message) => {
        try {
          const botUser = client.user;
          if (!botUser) return;

          // Ignore bot's own messages and other bots
          if (message.author.id === botUser.id) return;
          if (message.author.bot) return;

          const isDM = !message.guild;
          const isMentioned = message.mentions.has(botUser);

          // In guilds, only respond to mentions; in DMs, always respond
          if (!isDM && !isMentioned) return;

          const channelId = message.channelId;
          const userId = message.author.id;
          const rawText = message.content ?? "";
          const text = isDM ? rawText.trim() : stripBotMention(rawText);

          if (!text) return;

          // Try command handling first
          const cmdResponse = await handleTextCommand(text, channelId);
          if (cmdResponse) {
            await message.reply({ content: cmdResponse, allowedMentions: { parse: [] } });
            return;
          }

          logger.info(`[discord] message from ${userId} in ${channelId} (${isDM ? "DM" : "guild"})`);
          startTyping(channelId);
          try {
            await onMessage(
              {
                channelType: "discord",
                channelId,
                userId,
                text,
                teamId: commands.resolveTeamId(channelId),
              },
              channel,
            );
          } finally {
            stopTyping(channelId);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error(`[discord] error in MessageCreate handler: ${msg}`);
        }
      });

      await client.login(token);
      logger.info(`[discord] connected as ${client.user?.tag}`);
    },

    stop: async () => {
      for (const chatId of typingIntervals.keys()) stopTyping(chatId);
      await client.destroy();
      logger.info("[discord] disconnected");
    },

    send: async (channelId, text) => {
      stopTyping(channelId);
      await sendChunks(channelId, text);
    },
  };

  return channel;
}
