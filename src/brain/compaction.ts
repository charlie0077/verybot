import { generateText, type LanguageModel, type ModelMessage } from "ai";
import type { Session } from "./session.js";
import { logger } from "../logger.js";

const CHARS_PER_TOKEN = 4;
const SAFETY_MARGIN = 1.2;

// ── Scheduler compaction constants ──────────────────────────────────────────
/** Prefix injected into user messages for automated scheduled task runs. */
export const SCHEDULED_TASK_PREFIX = "[Scheduled Task]";
/** Prefix for compacted scheduler results in session history. */
export const SCHEDULER_RESULT_PREFIX = "[Scheduler Result |";
/** Max characters kept from the assistant response in a compacted line. */
const SCHEDULER_SUMMARY_MAX_LEN = 200;
/** Max characters kept from the task prompt in a compacted line. */
const SCHEDULER_PROMPT_MAX_LEN = 40;
/** Maximum number of compacted scheduler results retained in the session. */
const MAX_SCHEDULER_RESULTS = 100;
/** Keep the most recent N messages intact (not summarized). */
const KEEP_RECENT = 2;
/** Reserve tokens for model output (max response length). */
const OUTPUT_RESERVE = 8_192;

/** Estimate token count from a plain string. */
export function estimateStringTokens(text: string): number {
  return Math.ceil(Math.max(0, text.length) / CHARS_PER_TOKEN);
}

/** Estimate token count from message content. */
export function estimateTokens(messages: ModelMessage[]): number {
  let chars = 0;
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      chars += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if ("text" in part && typeof part.text === "string") {
          chars += part.text.length;
        }
      }
    }
  }
  return Math.ceil(Math.max(0, chars) / CHARS_PER_TOKEN);
}

/**
 * Compact conversation if estimated tokens exceed the context budget.
 *
 * Budget = contextWindow - systemPromptTokens - outputReserve
 *
 * Returns the (possibly compacted) messages and whether compaction occurred.
 */
export async function compactMessages(
  model: LanguageModel,
  messages: ModelMessage[],
  contextWindow: number,
  systemPrompt: string,
): Promise<{ messages: ModelMessage[]; compacted: boolean; summary?: string }> {
  const systemTokens = estimateStringTokens(systemPrompt);
  // Cap output reserve to 10% of context window so small windows aren't swamped
  const outputReserve = Math.min(OUTPUT_RESERVE, Math.floor(contextWindow * 0.1));
  const messageBudget = contextWindow - systemTokens - outputReserve;
  const estimated = estimateTokens(messages);

  if (estimated * SAFETY_MARGIN <= messageBudget) {
    return { messages, compacted: false };
  }

  logger.info(
    `Compaction triggered: ~${estimated} msg tokens * ${SAFETY_MARGIN} = ~${Math.ceil(estimated * SAFETY_MARGIN)} ` +
      `> budget ${messageBudget} (context ${contextWindow} - system ${systemTokens} - output ${outputReserve})`,
  );

  // Not enough messages for LLM summarization — fall back to dropping oldest
  if (messages.length <= KEEP_RECENT) {
    logger.info("Too few messages for summarization, falling back to truncation");
    return { messages: fallbackTruncate(messages, messageBudget), compacted: true };
  }

  // Dynamically adjust how many recent messages to keep based on budget
  const keepRecent = Math.max(2, Math.min(KEEP_RECENT, messages.length - 2));
  const recent = messages.slice(-keepRecent);
  const old = messages.slice(0, -keepRecent);

  // Extract readable text from old messages (skip tool parts)
  const transcript = buildTranscript(old);
  if (!transcript) {
    logger.info("No text content in old messages, skipping compaction");
    return { messages, compacted: false };
  }

  try {
    const summary = await summarize(model, transcript);
    const compacted: ModelMessage[] = [
      { role: "user", content: `[Prior conversation summary]\n${summary}` },
      ...recent,
    ];

    const afterTokens = estimateTokens(compacted);
    logger.info(
      `Compaction complete: ${estimated} -> ${afterTokens} tokens (${messages.length} -> ${compacted.length} messages)`,
    );

    return { messages: compacted, compacted: true, summary };
  } catch (err) {
    logger.warn(`Compaction LLM call failed: ${err instanceof Error ? err.message : err}`);
    // Fallback: drop oldest messages until under budget (no summary available)
    return { messages: fallbackTruncate(messages, messageBudget), compacted: true };
  }
}

/** Build a readable transcript from messages, skipping tool-use/tool-result parts. */
function buildTranscript(messages: ModelMessage[]): string | null {
  const lines: string[] = [];

  for (const msg of messages) {
    const role = msg.role === "user" ? "User" : "Assistant";
    if (typeof msg.content === "string") {
      lines.push(`${role}: ${msg.content}`);
    } else if (Array.isArray(msg.content)) {
      const textParts: string[] = [];
      for (const part of msg.content) {
        if ("text" in part && typeof part.text === "string") {
          textParts.push(part.text);
        }
      }
      if (textParts.length > 0) {
        lines.push(`${role}: ${textParts.join(" ")}`);
      }
    }
  }

  return lines.length > 0 ? lines.join("\n") : null;
}

/** Call LLM to summarize the conversation transcript. */
async function summarize(model: LanguageModel, transcript: string): Promise<string> {
  const { text } = await generateText({
    model,
    system:
      "You are a conversation summarizer. Produce a concise summary that preserves: " +
      "key facts about the user (name, preferences, location, etc.), " +
      "important decisions or agreements, " +
      "context needed to continue the conversation naturally. " +
      "Use bullet points. Be brief but complete.",
    messages: [
      {
        role: "user",
        content: `Summarize this conversation:\n\n${transcript}`,
      },
    ],
  });

  return text;
}

/** Fallback: drop oldest messages until estimated tokens fit within budget. Keep at least 2. */
function fallbackTruncate(messages: ModelMessage[], messageBudget: number): ModelMessage[] {
  let totalTokens = estimateTokens(messages);
  // Walk forward, subtracting each dropped message's tokens until under budget
  for (let i = 0; i < messages.length - 2; i++) {
    if (totalTokens * SAFETY_MARGIN <= messageBudget) {
      return messages.slice(i);
    }
    totalTokens -= estimateTokens([messages[i]]);
  }
  // Nothing fits — return the last 2 messages
  return messages.slice(-2);
}

/**
 * Programmatic compaction for scheduler sessions.
 *
 * 1. Collapses each [Scheduled Task] user msg + its assistant reply into a
 *    single "[Scheduler Result | ...]" one-liner. Human messages interleaved
 *    in the session are left untouched — only messages starting with
 *    SCHEDULED_TASK_PREFIX are candidates.
 * 2. Prunes old compacted results, keeping only the most recent MAX_SCHEDULER_RESULTS.
 *
 * No LLM cost — pure string manipulation.
 * Call before appending a new scheduled task so all existing runs become "previous".
 */
export function compactSchedulerRuns(session: Session): void {
  const messages = session.getMessages();
  let changed = 0;

  // Single backwards pass: compact uncompacted task runs and collect compacted indices.
  // Backwards iteration keeps splice indices stable for the compaction step.
  const compactedIndices: number[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "user" || typeof msg.content !== "string") continue;

    // Already compacted — track index for pruning
    if (msg.content.startsWith(SCHEDULER_RESULT_PREFIX)) {
      compactedIndices.push(i);
      continue;
    }

    // Uncompacted scheduled task — compact if followed by assistant reply
    if (!msg.content.startsWith(SCHEDULED_TASK_PREFIX)) continue;
    const next = messages[i + 1];
    if (!next || next.role !== "assistant") continue;

    const prompt = msg.content.slice(SCHEDULED_TASK_PREFIX.length).trim().slice(0, SCHEDULER_PROMPT_MAX_LEN);
    const response = typeof next.content === "string"
      ? next.content.slice(0, SCHEDULER_SUMMARY_MAX_LEN)
      : "completed";
    const timestamp = new Date().toISOString().slice(0, 16).replace("T", " ");

    messages.splice(i, 2, { role: "user", content: `${SCHEDULER_RESULT_PREFIX} ${timestamp} | ${prompt}] ${response}` });
    compactedIndices.push(i);
    changed++;
  }

  // compactedIndices is in descending order from the backwards pass — reverse for pruning
  compactedIndices.reverse();

  // Prune oldest compacted results beyond the cap
  const pruneCount = compactedIndices.length - MAX_SCHEDULER_RESULTS;
  if (pruneCount > 0) {
    // Remove oldest (lowest-index) entries; splice backwards to keep indices stable
    for (let i = pruneCount - 1; i >= 0; i--) {
      messages.splice(compactedIndices[i], 1);
    }
    changed += pruneCount;
    logger.info(`[scheduler] Pruned ${pruneCount} old result(s), keeping ${MAX_SCHEDULER_RESULTS}`);
  }

  if (changed > 0) {
    session.replaceMessages(messages);
    logger.info(`[scheduler] Compacted/pruned ${changed} scheduler message(s)`);
  }
}

/** Detect context overflow errors from various providers. */
export function isContextOverflowError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  const lower = msg.toLowerCase();
  return (
    lower.includes("request_too_large") ||
    lower.includes("context length exceeded") ||
    lower.includes("maximum context length") ||
    lower.includes("prompt is too long") ||
    lower.includes("exceeds model context window") ||
    lower.includes("request exceeds the maximum size") ||
    (lower.includes("request size exceeds") && lower.includes("context window")) ||
    (lower.includes("413") && lower.includes("too large"))
  );
}
