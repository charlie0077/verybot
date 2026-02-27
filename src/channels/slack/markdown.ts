/**
 * Markdown → Slack mrkdwn conversion.
 * Slack uses a custom markdown-like format called "mrkdwn".
 */

import {
  chunkMarkdownIR,
  markdownToIR,
  type MarkdownLinkSpan,
  type MarkdownIR,
  type MarkdownTableMode,
} from "../../markdown/ir.js";
import { renderMarkdownWithMarkers } from "../../markdown/render.js";

const SAFE_LINK_PROTOCOL = /^https?:\/\/|^mailto:|^tel:/i;

/** Slack mrkdwn uses &, <, > as control chars — escape them in plain text. */
export function escapeSlackMrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildSlackLink(link: MarkdownLinkSpan, _text: string) {
  const href = link.href.trim();
  if (!href || link.start === link.end) return null;
  if (!SAFE_LINK_PROTOCOL.test(href)) return null;
  return {
    start: link.start,
    end: link.end,
    open: `<${escapeSlackMrkdwn(href)}|`,
    close: ">",
  };
}

function renderSlackMrkdwn(ir: MarkdownIR): string {
  return renderMarkdownWithMarkers(ir, {
    styleMarkers: {
      bold: { open: "*", close: "*" },
      italic: { open: "_", close: "_" },
      strikethrough: { open: "~", close: "~" },
      code: { open: "`", close: "`" },
      code_block: { open: "```\n", close: "\n```" },
    },
    escapeText: escapeSlackMrkdwn,
    buildLink: buildSlackLink,
  });
}

export function markdownToSlackMrkdwn(
  markdown: string,
  options: { tableMode?: MarkdownTableMode } = {},
): string {
  const ir = markdownToIR(markdown ?? "", {
    linkify: true,
    headingStyle: "none",
    blockquotePrefix: "> ",
    tableMode: options.tableMode,
  });
  return renderSlackMrkdwn(ir);
}

/** Slack message limit (text blocks). */
export const SLACK_TEXT_LIMIT = 4000;

/**
 * Convert markdown to chunked Slack mrkdwn strings.
 * Each chunk is ≤ `limit` characters of plain-text IR.
 */
export function markdownToSlackMrkdwnChunks(
  markdown: string,
  limit: number = SLACK_TEXT_LIMIT,
  options: { tableMode?: MarkdownTableMode } = {},
): string[] {
  const ir = markdownToIR(markdown ?? "", {
    linkify: true,
    headingStyle: "none",
    blockquotePrefix: "> ",
    tableMode: options.tableMode,
  });
  const chunks = chunkMarkdownIR(ir, limit);
  return chunks.map((chunk) => renderSlackMrkdwn(chunk));
}
