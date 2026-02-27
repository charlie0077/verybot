import winston from "winston";
import Transport from "winston-transport";

const { combine, timestamp, printf, colorize } = winston.format;

const ANSI_RE = /\x1b\[[0-9;]*m/g;

// ANSI escape codes
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const BOLD = "\x1b[1m";

// Map raw level names to message colors
const MESSAGE_COLORS: Record<string, string> = {
  error: RED,
  warn: YELLOW,
};

// Detect user message lines: "  [user] ..." (from loop.ts role logging)
const USER_MSG_RE = /^(.*)\[user\]\s+(.*)$/s;

const logFormat = printf(({ level, message, timestamp }) => {
  // strip ANSI from level to get raw name for color lookup
  const rawLevel = level.replace(ANSI_RE, "");
  const msg = String(message);

  // Highlight user messages in bold green
  const userMatch = msg.match(USER_MSG_RE);
  if (userMatch) {
    const [, prefix, body] = userMatch;
    return `${DIM}${timestamp}${RESET} [${level}] ${prefix}${BOLD}${GREEN}[user]${RESET} ${GREEN}${body}${RESET}`;
  }

  const msgColor = MESSAGE_COLORS[rawLevel] ?? "";
  const msgReset = msgColor ? RESET : "";

  return `${DIM}${timestamp}${RESET} [${level}] ${msgColor}${msg}${msgReset}`;
});

// --------------- Ring buffer for UI log streaming ---------------

const LOG_BUFFER_SIZE = 500;

/** Pattern sources for secrets — fresh RegExp per call to avoid /g lastIndex state. */
const SENSITIVE_PATTERN_SOURCES: Array<{ source: string; flags: string }> = [
  { source: "Bearer\\s+[A-Za-z0-9\\-._~+/]+=*", flags: "g" },
  { source: "token=[A-Za-z0-9\\-._~+/]+", flags: "gi" },
  { source: "(?:api[_-]?key|secret|password|credential)[\\s=:]+\\S+", flags: "gi" },
  // Common API key prefixes (OpenAI, Anthropic, GitHub, Stripe, etc.)
  { source: "(?:sk|pk)[-_][A-Za-z0-9\\-._]{20,}", flags: "g" },
  { source: "ghp_[A-Za-z0-9]{36}", flags: "g" },
  // Connection strings with embedded passwords
  { source: "[a-z]+://[^:]+:[^@]+@", flags: "gi" },
];

function redactSensitive(msg: string): string {
  let out = msg;
  for (const { source, flags } of SENSITIVE_PATTERN_SOURCES) {
    out = out.replace(new RegExp(source, flags), "[REDACTED]");
  }
  return out;
}

export interface LogEntry {
  ts: string;
  level: string;
  message: string;
}

const logBuffer: LogEntry[] = new Array(LOG_BUFFER_SIZE);
let ringHead = 0;   // next write index
let ringCount = 0;   // total entries in buffer

type LogSubscriber = (entry: LogEntry) => void;
const logSubscribers = new Set<LogSubscriber>();

/**
 * Register a subscriber for real-time log entries.
 * Returns an unsubscribe function.
 */
export function addLogSubscriber(cb: LogSubscriber): () => void {
  logSubscribers.add(cb);
  return () => { logSubscribers.delete(cb); };
}

/** Return a snapshot of the current log buffer in chronological order. */
export function getLogBuffer(): LogEntry[] {
  if (ringCount === 0) return [];
  if (ringCount < LOG_BUFFER_SIZE) return logBuffer.slice(0, ringCount);
  // Buffer is full — oldest entry starts at ringHead
  return [...logBuffer.slice(ringHead), ...logBuffer.slice(0, ringHead)];
}

/**
 * Custom Winston transport that feeds the ring buffer and notifies
 * subscribed UI clients only.
 */
class UiBroadcastTransport extends Transport {
  log(info: { timestamp?: string; level: string; message: string }, next: () => void) {
    const raw = String(info.message).replace(ANSI_RE, "");
    const entry: LogEntry = {
      ts: info.timestamp ?? new Date().toISOString(),
      level: info.level.replace(ANSI_RE, ""),
      message: redactSensitive(raw),
    };

    // Ring buffer: O(1) insert via index wrapping
    logBuffer[ringHead] = entry;
    ringHead = (ringHead + 1) % LOG_BUFFER_SIZE;
    if (ringCount < LOG_BUFFER_SIZE) ringCount++;

    for (const cb of logSubscribers) cb(entry);
    next();
  }
}

// ----------------------------------------------------------------

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL ?? "info",
  format: combine(
    timestamp({ format: "HH:mm:ss" }),
    colorize(),
    logFormat,
  ),
  transports: [
    new winston.transports.Console(),
    new UiBroadcastTransport(),
  ],
});
