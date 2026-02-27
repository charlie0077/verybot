import {
  streamText,
  stepCountIs,
  type AssistantModelMessage,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from "ai";
import { emit } from "../events.js";
import { logger } from "../logger.js";

const NO_RESPONSE_TEXT = "(no response)";
const IMAGE_ONLY_RESPONSE_TEXT = "Generated an image.";

export interface RunLoopResult {
  /** The final text reply. */
  text: string;
  /** All response messages (assistant + tool) generated during the run. */
  responseMessages: ModelMessage[];
  /** Structured assistant content from the model response (text/files/tool parts). */
  assistantContent: AssistantModelMessage["content"] | null;
}

export async function runLoop(opts: {
  model: LanguageModel;
  system: string;
  messages: ModelMessage[];
  tools: ToolSet;
  sessionKey: string;
  abortSignal?: AbortSignal;
  maxSteps?: number;
  /** Worker agent ID (e.g. "researcher"). Undefined for the orchestrator. */
  agentId?: string;
  /** Suppress all WebSocket broadcasts (used for background workers). */
  silent?: boolean;
  /** Human-readable label for logs (e.g. team name instead of UUID). Falls back to sessionKey. */
  sessionLabel?: string;
}): Promise<RunLoopResult> {
  const {
    model, system, messages, tools, sessionKey, abortSignal, maxSteps = 20, agentId, silent = false, sessionLabel,
  } = opts;
  const tag = `[${sessionLabel ?? sessionKey}]`;
  const runStart = Date.now();
  let aborted = false;

  logger.info(`\n${tag} ════════════════════════════════════════`);
  logger.info(`\x1b[36m${tag}   model: ${typeof model === "string" ? model : model.modelId}  tools: [${Object.keys(tools).join(", ")}]\x1b[0m`);
  logger.info(`${tag}   maxSteps: ${maxSteps}`);
  logger.info(`${tag} ── SYSTEM PROMPT ──\n${system}`);
  logger.info(`${tag} ── MESSAGES (${messages.length}) ──`);
  for (const msg of messages) {
    const body = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
    logger.info(`${tag}   [${msg.role}] ${body.slice(0, 2000)}`);
  }

  let stepNum = 0;
  let stepStart = Date.now();
  const result = streamText({
    model,
    system,
    messages,
    tools,
    abortSignal,
    stopWhen: stepCountIs(maxSteps),
    onAbort({ steps }) {
      aborted = true;
      logger.info(`${tag}   ⛔ aborted after ${steps.length} steps`);
    },
    onStepFinish({ text, reasoningText, toolCalls, toolResults, usage }) {
      stepNum++;
      const elapsed = Date.now() - stepStart;
      logger.info(`${tag} ── step ${stepNum}/${maxSteps} (${elapsed}ms) ──`);

      if (reasoningText) {
        logger.info(`${tag}   🧠 reasoning: ${reasoningText.slice(0, 1500)}`);
      }
      if (toolCalls.length > 0) {
        for (const tc of toolCalls) {
          logger.info(`${tag}   🔧 call: ${tc.toolName}(${JSON.stringify(tc.input)})`);
        }
        if (!silent) {
          emit("agent", {
            sessionKey,
            agentId,
            tools: toolCalls.map((tc) => ({ name: tc.toolName, args: tc.input })),
          });
        }
      }
      if (toolResults.length > 0) {
        for (const tr of toolResults) {
          const out = tr.output;
          // Skip binary/image data from logs
          const isImage = Buffer.isBuffer(out) ||
            (typeof out === "object" && out !== null && "data" in out && Buffer.isBuffer((out as Record<string, unknown>).data));
          if (isImage) {
            const size = Buffer.isBuffer(out) ? out.length : (out as { data: Buffer }).data.length;
            logger.info(`${tag}   ← ${tr.toolName}: [image ${size} bytes]`);
          } else {
            const full = String(out);
            if (looksLikeHtml(full)) {
              logger.info(`${tag}   ← ${tr.toolName} (${full.length} chars): [HTML] ${extractHtmlSummary(full)}`);
            } else {
              logger.info(`${tag}   ← ${tr.toolName} (${full.length} chars): ${full.slice(0, 1500)}`);
            }
          }
        }
      }
      if (text) {
        logger.info(`${tag}   💬 text: ${text.slice(0, 500)}`);
      }
      if (usage) {
        logger.info(`${tag}   📊 tokens: ${usage.inputTokens} in / ${usage.outputTokens} out`);
      }
      stepStart = Date.now();
    },
  });

  // Consume fullStream (not textStream) so errors surface here instead of
  // becoming unhandled rejections from an unconsumed internal pipeline.
  let collected = "";
  let lastError: unknown = null;

  try {
    for await (const event of result.fullStream) {
      if (event.type === "text-delta") {
        collected += event.text;
        if (!silent) {
          emit("chat", {
            sessionKey,
            agentId,
            state: "delta",
            delta: event.text,
          });
        }
      } else if (event.type === "abort") {
        aborted = true;
      } else if (event.type === "error") {
        lastError = event.error;
      }
    }
  } catch (err) {
    // fullStream flush may throw NoOutputGeneratedError — capture it
    if (!lastError) lastError = err;
    if (isAbortLikeError(err)) aborted = true;
  }

  if (abortSignal?.aborted) {
    aborted = true;
  }

  if (aborted) {
    // Consume result promises to avoid unhandled rejections on early aborts.
    const settled = await Promise.allSettled([Promise.resolve(result), result.response]);
    for (const item of settled) {
      if (item.status === "rejected" && !isAbortLikeError(item.reason)) {
        logger.warn(`${tag} Unexpected abort settle error: ${String(item.reason)}`);
      }
    }

    const totalMs = Date.now() - runStart;
    logger.info(`${tag} ── ABORTED (${collected.length} chars, ${stepNum} steps, ${totalMs}ms) ──`);
    logger.info(`${tag} ════════════════════════════════════════\n`);

    if (!silent && collected.length > 0) {
      emit("chat", {
        sessionKey,
        agentId,
        state: "final",
        message: { role: "assistant", content: collected },
      });
    }

    return {
      text: collected,
      responseMessages: [],
      assistantContent: null,
    };
  }

  // If no text was produced and we captured an error, re-throw it
  // so Agent.handleMessage can send a friendly error to the user.
  if (!collected && lastError) {
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  const final = await result;
  const resp = await result.response;
  const responseMessages = (resp.messages ?? []) as ModelMessage[];
  const assistantContent = findLastAssistantContent(responseMessages);
  const assistantText = extractAssistantText(assistantContent);
  const text = collected.length > 0
    ? collected
    : assistantText.length > 0
      ? assistantText
      : hasImageOutput(assistantContent)
        ? IMAGE_ONLY_RESPONSE_TEXT
        : NO_RESPONSE_TEXT;
  const totalMs = Date.now() - runStart;

  logger.info(`${tag} ── FINAL REPLY (${text.length} chars, ${stepNum} steps, ${totalMs}ms) ──`);
  logger.info(`${tag} ${text}`);
  logger.info(`${tag} ════════════════════════════════════════\n`);

  if (!silent) {
      emit("chat", {
        sessionKey,
        agentId,
        state: "final",
        message: { role: "assistant", content: assistantContent ?? text },
        usage: final.usage,
      });
  }

  return {
    text,
    responseMessages,
    assistantContent,
  };
}

function findLastAssistantContent(messages: ModelMessage[]): AssistantModelMessage["content"] | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "assistant") {
      return normalizeAssistantContent(message.content);
    }
  }
  return null;
}

function normalizeAssistantContent(content: AssistantModelMessage["content"]): AssistantModelMessage["content"] {
  if (!Array.isArray(content)) return content;

  return content.map((part) => {
    if (!part || typeof part !== "object") return part;

    const candidate = part as Record<string, unknown>;
    if (candidate.type !== "file") return part;

    const data = normalizeDataContent(candidate.data);
    return { ...candidate, data };
  }) as AssistantModelMessage["content"];
}

function normalizeDataContent(data: unknown): unknown {
  if (Buffer.isBuffer(data)) {
    return data.toString("base64");
  }
  if (data instanceof Uint8Array) {
    return Buffer.from(data).toString("base64");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("base64");
  }
  if (data instanceof URL) {
    return data.toString();
  }
  return data;
}

function extractAssistantText(content: AssistantModelMessage["content"] | null): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const texts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const candidate = part as Record<string, unknown>;
    if (candidate.type === "text" && typeof candidate.text === "string") {
      texts.push(candidate.text);
      continue;
    }
    if (candidate.type === "tool-result" && candidate.output && typeof candidate.output === "object") {
      const output = candidate.output as Record<string, unknown>;
      if (output.type === "text" && typeof output.value === "string") {
        texts.push(output.value);
      }
    }
  }

  return texts.join("\n");
}

function hasImageOutput(content: AssistantModelMessage["content"] | null): boolean {
  if (!Array.isArray(content)) return false;

  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const candidate = part as Record<string, unknown>;

    if (candidate.type === "file" && isImageMediaType(candidate.mediaType)) {
      return true;
    }

    if (candidate.type !== "tool-result" || !candidate.output || typeof candidate.output !== "object") {
      continue;
    }

    const output = candidate.output as Record<string, unknown>;
    if (output.type !== "content" || !Array.isArray(output.value)) continue;

    for (const item of output.value) {
      if (!item || typeof item !== "object") continue;
      const contentItem = item as Record<string, unknown>;
      if (
        contentItem.type === "image-data" ||
        contentItem.type === "image-url" ||
        contentItem.type === "image-file-id"
      ) {
        return true;
      }
      if (contentItem.type === "media" && isImageMediaType(contentItem.mediaType)) {
        return true;
      }
      if (contentItem.type === "file-data" && isImageMediaType(contentItem.mediaType)) {
        return true;
      }
    }
  }

  return false;
}

function isImageMediaType(mediaType: unknown): boolean {
  return typeof mediaType === "string" && mediaType.toLowerCase().startsWith("image/");
}

function isAbortLikeError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "AbortError") return true;
  const msg = err.message.toLowerCase();
  return msg.includes("aborted") || msg.includes("abort");
}

/** When the model ends on a tool call, try to pull text from the last tool result. */
function extractFallbackText(final: { steps: Array<{ toolResults?: Array<{ output?: unknown }> }> }): string | undefined {
  for (let i = final.steps.length - 1; i >= 0; i--) {
    const results = final.steps[i].toolResults;
    if (results && results.length > 0) {
      const last = results[results.length - 1].output;
      return typeof last === "string" ? last : JSON.stringify(last);
    }
  }
  return undefined;
}

function lastUserMessage(messages: ModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      const content = messages[i].content;
      const text = typeof content === "string" ? content : JSON.stringify(content);
      return text.slice(0, 200);
    }
  }
  return "(empty)";
}

/** Quick check for HTML-heavy content that would be noisy in logs. */
function looksLikeHtml(s: string): boolean {
  const start = s.slice(0, 500);
  return start.includes("<!DOCTYPE") || start.includes("<html") || (start.match(/<\w/g)?.length ?? 0) > 5;
}

/** Pull title + meta description from raw HTML for a compact summary. */
function extractHtmlSummary(html: string): string {
  const title = html.match(/<title[^>]*>(.*?)<\/title>/is)?.[1]?.trim() ?? "";
  const desc =
    html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)/i)?.[1]?.trim() ??
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i)?.[1]?.trim() ??
    "";
  const parts = [title && `title="${title}"`, desc && `desc="${desc.slice(0, 150)}"`].filter(Boolean);
  return parts.length > 0 ? parts.join(" | ") : "(no meta)";
}
