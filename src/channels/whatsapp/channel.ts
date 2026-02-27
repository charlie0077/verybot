import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  generateMessageIDV2,
  type AnyMessageContent,
  type WASocket,
} from "@whiskeysockets/baileys";
import type { Channel, MessageHandler } from "../types.js";
import { transcribe } from "../../tts/transcribe.js";
import { logger } from "../../logger.js";
import { markdownToWhatsAppChunks, escapeWhatsApp, WHATSAPP_TEXT_LIMIT } from "./markdown.js";
import type { MarkdownTableMode } from "../../markdown/ir.js";
import { CommandRouter, type CommandResult, type CommandPart } from "../commands.js";
import { WHATSAPP_AUTH_DIR } from "../../paths.js";
import { emit } from "../../events.js";
import QRCode from "qrcode";

/** Typing indicator refresh interval (WhatsApp presence expires ~10s). */
const TYPING_INTERVAL_MS = 5000;

/** Initial reconnect delay (doubles on each attempt). */
const BASE_RECONNECT_DELAY_MS = 1000;

/** Cap reconnect backoff at 60s. */
const MAX_RECONNECT_DELAY_MS = 60_000;

/** Max number of sent message IDs to track for loop prevention. */
const SENT_IDS_LIMIT = 500;

/** Callback that resolves the current table mode from config at send time. */
export type ResolveTableMode = () => MarkdownTableMode;

export interface CreateWhatsAppChannelOpts {
  /**
   * Opaque identifier for config gating and channel fingerprinting.
   * Baileys authenticates via QR code; this value is not sent to WhatsApp.
   * Set any non-empty string (e.g. your phone number) to enable the channel.
   */
  phoneId: string;
  /** When true, only process messages sent by myself (fromMe). */
  selfOnly?: boolean;
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
  listTeams?: () => { id: string; name: string }[];
  defaultTeamId?: string;
  resolveTableMode?: ResolveTableMode;
}

/**
 * Thin pino-compatible logger adapter that forwards to Winston.
 * Baileys expects a pino-shaped logger with child(), level, and log methods.
 */
function createBaileysLogger() {
  const noop = () => {};
  const adapter = {
    level: "silent",
    trace: noop,
    debug: noop,
    info: (msg: unknown) => logger.debug(`[baileys] ${msg}`),
    warn: (msg: unknown) => logger.warn(`[baileys] ${msg}`),
    error: (msg: unknown) => logger.error(`[baileys] ${msg}`),
    fatal: (msg: unknown) => logger.error(`[baileys:fatal] ${msg}`),
    child: () => adapter,
  };
  return adapter;
}

export function createWhatsAppChannel(opts: CreateWhatsAppChannelOpts): Channel {
  const {
    onMessage,
    onClear,
    onLearn,
    onRemember,
    listTeams,
    defaultTeamId,
    selfOnly = false,
    resolveTableMode = () => "bullets",
  } = opts;

  let sock: WASocket | null = null;
  let stopped = false;
  let reconnectAttempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const typingIntervals = new Map<string, ReturnType<typeof setInterval>>();
  const commands = new CommandRouter({ onClear, onLearn, onRemember, listTeams, defaultTeamId });

  /** IDs of messages sent by the bot — used to avoid processing our own replies. */
  const sentIds = new Set<string>();
  function trackSentId(id: string | undefined | null) {
    if (!id) return;
    sentIds.add(id);
    if (sentIds.size > SENT_IDS_LIMIT) {
      const first = sentIds.values().next().value!;
      sentIds.delete(first);
    }
  }

  /**
   * Send an outbound WhatsApp message with a pre-generated ID so we can
   * suppress self-echoes even if upsert arrives before sendMessage resolves.
   */
  async function sendTrackedMessage(jid: string, content: AnyMessageContent): Promise<void> {
    const activeSock = sock;
    if (!activeSock) return;
    const messageId = generateMessageIDV2(activeSock.user?.id);
    trackSentId(messageId);
    const sent = await activeSock.sendMessage(jid, content, { messageId });
    trackSentId(sent?.key?.id);
  }

  /** Format a CommandResult using WhatsApp formatting. */
  function formatResult(result: CommandResult): string {
    return result.parts
      .map((p: CommandPart) => {
        if (typeof p === "string") return escapeWhatsApp(p);
        if ("bold" in p) return `*${escapeWhatsApp(p.bold)}*`;
        return `\`${p.code}\``;
      })
      .join("");
  }

  function startTyping(jid: string) {
    stopTyping(jid);
    sock?.sendPresenceUpdate("composing", jid).catch((err) =>
      logger.error(`[whatsapp] typing error: ${err}`),
    );
    const interval = setInterval(() => {
      sock?.sendPresenceUpdate("composing", jid).catch((err) =>
        logger.error(`[whatsapp] typing interval error: ${err}`),
      );
    }, TYPING_INTERVAL_MS);
    typingIntervals.set(jid, interval);
  }

  function stopTyping(jid: string) {
    const interval = typingIntervals.get(jid);
    const hadActiveTyping = Boolean(interval);
    if (interval) {
      clearInterval(interval);
      typingIntervals.delete(jid);
    }
    if (hadActiveTyping) {
      sock?.sendPresenceUpdate("paused", jid).catch(() => {});
    }
  }

  function clearAllTyping() {
    for (const jid of typingIntervals.keys()) stopTyping(jid);
  }

  async function connectSocket(): Promise<void> {
    if (stopped) return;
    // Clear stale typing intervals from previous connection
    clearAllTyping();

    const { state, saveCreds } = await useMultiFileAuthState(WHATSAPP_AUTH_DIR);

    sock = makeWASocket({
      auth: state,
      logger: createBaileysLogger() as never,
      printQRInTerminal: false, // QR is sent to UI via event bus
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      // Broadcast QR code to UI clients
      if (qr) {
        try {
          const dataUrl = await QRCode.toDataURL(qr, { width: 256 });
          emit("whatsapp", { type: "qr", dataUrl });
        } catch (err) {
          logger.error(`[whatsapp] QR generation failed: ${err}`);
        }
      }

      if (connection === "close") {
        emit("whatsapp", { type: "disconnected" });
        const statusCode =
          (lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;

        if (isLoggedOut) {
          logger.warn("[whatsapp] logged out — will not reconnect");
          return;
        }

        if (!stopped) {
          const delay = Math.min(BASE_RECONNECT_DELAY_MS * 2 ** reconnectAttempts, MAX_RECONNECT_DELAY_MS);
          reconnectAttempts++;
          logger.info(`[whatsapp] disconnected (code ${statusCode}), reconnecting in ${delay}ms...`);
          if (reconnectTimer) clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            void connectSocket();
          }, delay);
        }
      }

      if (connection === "open") {
        reconnectAttempts = 0;
        emit("whatsapp", { type: "connected" });
        logger.info("[whatsapp] connected");
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      logger.info(`[whatsapp] messages.upsert: type=${type}, count=${messages.length}`);

      for (const msg of messages) {
        try {
          logger.info(`[whatsapp] msg: fromMe=${msg.key.fromMe}, jid=${msg.key.remoteJid}, id=${msg.key.id}, hasMessage=${!!msg.message}`);
          if (!msg.message) continue;
          // Skip messages sent by the bot to avoid loops.
          if (msg.key.id && sentIds.has(msg.key.id)) continue;
          // In self-only mode, ignore messages from others
          if (selfOnly && !msg.key.fromMe) continue;

          const jid = msg.key.remoteJid;
          if (!jid) continue;

          const userId = msg.key.participant ?? jid;

          // Voice message handling
          const audioMsg = msg.message.audioMessage;
          if (audioMsg?.ptt) {
            logger.info(`[whatsapp] voice message received`);
            startTyping(jid);
            try {
              const buffer = await downloadMediaMessage(msg, "buffer", {}) as Buffer;
              const text = await transcribe(buffer, "voice.ogg");
              logger.info(`[whatsapp] transcribed voice (${text.length} chars)`);
              await onMessage(
                {
                  channelType: "whatsapp",
                  channelId: jid,
                  userId,
                  text,
                  isVoice: true,
                  teamId: commands.resolveTeamId(jid),
                },
                channel,
              );
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              logger.error(`[whatsapp] voice transcription failed: ${errMsg}`);
              await sendTrackedMessage(jid, { text: "Sorry, I couldn't process your voice message." });
            } finally {
              stopTyping(jid);
            }
            continue;
          }

          // Text message handling
          const text =
            msg.message.conversation ??
            msg.message.extendedTextMessage?.text;
          if (!text) continue;

          // Try command handling first
          const cmdResult = await commands.handle("whatsapp", jid, text);
          if (cmdResult) {
            await sendTrackedMessage(jid, { text: formatResult(cmdResult) });
            continue;
          }

          logger.info(`[whatsapp] message received`);
          startTyping(jid);
          try {
            await onMessage(
              {
                channelType: "whatsapp",
                channelId: jid,
                userId,
                text,
                teamId: commands.resolveTeamId(jid),
              },
              channel,
            );
          } finally {
            stopTyping(jid);
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          logger.error(`[whatsapp] error handling message: ${errMsg}`);
        }
      }
    });
  }

  const channel: Channel = {
    name: "whatsapp",

    start: async () => {
      stopped = false;
      reconnectAttempts = 0;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      await connectSocket();
    },

    stop: async () => {
      stopped = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      clearAllTyping();
      sock?.end(undefined);
      sock = null;
    },

    send: async (channelId, text) => {
      stopTyping(channelId);
      const tableMode = resolveTableMode();
      const chunks = markdownToWhatsAppChunks(text, WHATSAPP_TEXT_LIMIT, { tableMode });
      if (chunks.length === 0 && text) {
        await sendTrackedMessage(channelId, { text });
        return;
      }
      for (const chunk of chunks) {
        await sendTrackedMessage(channelId, { text: chunk });
      }
    },

    sendVoice: async (channelId, audioPath) => {
      stopTyping(channelId);
      const { readFile } = await import("fs/promises");
      const audio = await readFile(audioPath);
      await sendTrackedMessage(channelId, {
        audio,
        mimetype: "audio/ogg; codecs=opus",
        ptt: true,
      });
      logger.info(`[whatsapp] voice message sent`);
    },
  };

  return channel;
}
