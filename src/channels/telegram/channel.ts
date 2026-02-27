import { Bot, InputFile } from "grammy";
import type { Channel, MessageHandler } from "../types.js";
import { transcribe } from "../../tts/transcribe.js";
import { logger } from "../../logger.js";
import { markdownToTelegramHtmlChunks, escapeHtml } from "./markdown.js";
import type { MarkdownTableMode } from "../../markdown/ir.js";
import { CommandRouter, type CommandResult, type CommandPart } from "../commands.js";

const TELEGRAM_TEXT_LIMIT = 4000;

/** Callback that resolves the current table mode from config at send time. */
export type ResolveTableMode = () => MarkdownTableMode;

/** Send chunked HTML to a Telegram chat. Handles markdown→HTML conversion + splitting. */
async function sendHtmlChunks(bot: Bot, chatId: number, text: string, resolveTableMode: ResolveTableMode) {
  const tableMode = resolveTableMode();
  const chunks = markdownToTelegramHtmlChunks(text, TELEGRAM_TEXT_LIMIT, { tableMode });
  if (chunks.length === 0 && text) {
    // Fallback: if conversion produced nothing, send raw text
    await bot.api.sendMessage(chatId, text);
    return;
  }
  for (const chunk of chunks) {
    await bot.api.sendMessage(chatId, chunk, { parse_mode: "HTML" });
  }
}

export interface CreateTelegramChannelOpts {
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
  /** Fallback team when no active team is set for a chat. */
  defaultTeamId?: string;
  resolveTableMode?: ResolveTableMode;
}

export function createTelegramChannel(opts: CreateTelegramChannelOpts): Channel {
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
  const bot = new Bot(token);
  const typingIntervals = new Map<string, ReturnType<typeof setInterval>>();

  const commands = new CommandRouter({ onClear, onLearn, onRemember, listTeams, defaultTeamId });

  /** Format a CommandResult using Telegram HTML syntax. */
  function formatTelegramResult(result: CommandResult): string {
    return result.parts
      .map((p: CommandPart) => {
        if (typeof p === "string") return escapeHtml(p);
        if ("bold" in p) return `<b>${escapeHtml(p.bold)}</b>`;
        return `<code>${escapeHtml(p.code)}</code>`;
      })
      .join("");
  }

  function startTyping(chatId: string) {
    stopTyping(chatId);
    const numId = Number(chatId);
    // Send immediately, then every 4s (Telegram typing expires after ~5s)
    bot.api.sendChatAction(numId, "typing").catch((err) => logger.error(`typing error: ${err}`));
    logger.info(`typing started for ${chatId}`);
    const interval = setInterval(() => {
      bot.api.sendChatAction(numId, "typing").catch((err) => logger.error(`typing interval error: ${err}`));
    }, 4000);
    typingIntervals.set(chatId, interval);
  }

  function stopTyping(chatId: string) {
    const interval = typingIntervals.get(chatId);
    if (interval) {
      clearInterval(interval);
      typingIntervals.delete(chatId);
    }
  }

  const channel: Channel = {
    name: "telegram",
    start: async () => {
      for (const cmd of ["clear", "reset"] as const) {
        bot.command(cmd, async (ctx) => {
          const chatId = String(ctx.chat.id);
          const result = await commands.handleClear("telegram", chatId);
          await ctx.reply(formatTelegramResult(result), { parse_mode: "HTML" });
        });
      }

      // --- /team command for multi-team switching ---
      if (listTeams) {
        bot.command("team", async (ctx) => {
          try {
            const chatId = String(ctx.chat.id);
            const arg = ctx.match?.trim() ?? "";
            const result = await commands.handleTeam("telegram", chatId, arg);
            await ctx.reply(formatTelegramResult(result), { parse_mode: "HTML" });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error(`[telegram] /team command failed: ${msg}`);
            await ctx.reply("Failed to process team command. Please try again.");
          }
        });
      }

      for (const cmd of ["learn", "remember"] as const) {
        bot.command(cmd, async (ctx) => {
          try {
            const chatId = String(ctx.chat.id);
            const arg = ctx.match?.trim() ?? "";
            const text = arg ? `/${cmd} ${arg}` : `/${cmd}`;
            const result = await commands.handle("telegram", chatId, text);
            if (!result) return;
            await ctx.reply(formatTelegramResult(result), { parse_mode: "HTML" });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error(`[telegram] /${cmd} command failed: ${msg}`);
            await ctx.reply("Failed to process memory command. Please try again.");
          }
        });
      }

      bot.on("message:voice", async (ctx) => {
        const chatId = String(ctx.chat.id);
        logger.info(`[telegram] voice message received from ${chatId}`);
        startTyping(chatId);
        try {
          const file = await ctx.getFile();
          const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
          const res = await fetch(url);
          if (!res.ok) throw new Error(`Download failed: ${res.status}`);
          const buffer = Buffer.from(await res.arrayBuffer());
          const text = await transcribe(buffer, file.file_path ?? "voice.ogg");
          logger.info(`[telegram] transcribed voice: "${text.slice(0, 100)}"`);
          await onMessage(
            {
              channelType: "telegram",
              channelId: chatId,
              userId: String(ctx.from.id),
              text,
              isVoice: true,
              teamId: commands.resolveTeamId(chatId),
            },
            channel
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error(`[telegram] voice transcription failed: ${msg}`);
          await ctx.reply("Sorry, I couldn't process your voice message.");
        } finally {
          stopTyping(chatId);
        }
      });

      bot.on("message:text", async (ctx) => {
        // Skip bot commands — registered ones are handled by bot.command(),
        // unregistered ones (e.g. /help) should not be forwarded as text
        const entities = ctx.message.entities ?? [];
        if (entities.some((e) => e.type === "bot_command" && e.offset === 0)) return;

        const chatId = String(ctx.chat.id);
        logger.info(`[telegram] message received from ${chatId}`);
        startTyping(chatId);
        try {
          await onMessage(
            {
              channelType: "telegram",
              channelId: chatId,
              userId: String(ctx.from.id),
              text: ctx.message.text,
              teamId: commands.resolveTeamId(chatId),
            },
            channel
          );
        } finally {
          stopTyping(chatId);
        }
      });
      // Register commands with Telegram so they appear in the "/" menu
      const menuCommands: { command: string; description: string }[] = [
        { command: "clear", description: "Clear the current session." },
        { command: "reset", description: "Clear the current session." },
        { command: "learn", description: "Teach me a fact to remember." },
      ];
      if (listTeams) {
        menuCommands.push({ command: "team", description: "List or switch teams." });
      }

      bot.start();

      // setMyCommands after start() so Grammy has initialized the bot
      bot.api.setMyCommands(menuCommands).then(
        () => logger.info(`[telegram] registered ${menuCommands.length} commands`),
        (err) => logger.error(`[telegram] setMyCommands failed: ${err}`),
      );
    },
    stop: async () => {
      for (const chatId of typingIntervals.keys()) stopTyping(chatId);
      await bot.stop();
    },
    send: async (channelId, text) => {
      stopTyping(channelId);
      await sendHtmlChunks(bot, Number(channelId), text, resolveTableMode);
    },
    sendVoice: async (channelId, audioPath) => {
      stopTyping(channelId);
      const chatId = Number(channelId);
      await bot.api.sendVoice(chatId, new InputFile(audioPath));
      logger.info(`[telegram] voice message sent to ${channelId}`);
    },
  };

  return channel;
}
