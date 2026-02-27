/**
 * Markdown → Discord markdown conversion.
 * Discord supports standard markdown natively, with minor escaping needs.
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

/** Discord message character limit. */
export const DISCORD_TEXT_LIMIT = 2000;

/** Escape Discord markdown special characters in plain text. */
export function escapeDiscord(text: string): string {
  return text.replace(/([*_~`|>\\])/g, "\\$1");
}

function buildDiscordLink(link: MarkdownLinkSpan, _text: string) {
  const href = link.href.trim();
  if (!href || link.start === link.end) return null;
  if (!SAFE_LINK_PROTOCOL.test(href)) return null;
  return {
    start: link.start,
    end: link.end,
    open: "[",
    close: `](${href})`,
  };
}

function renderDiscordMarkdown(ir: MarkdownIR): string {
  return renderMarkdownWithMarkers(ir, {
    styleMarkers: {
      bold: { open: "**", close: "**" },
      italic: { open: "*", close: "*" },
      strikethrough: { open: "~~", close: "~~" },
      code: { open: "`", close: "`" },
      code_block: { open: "```\n", close: "\n```" },
    },
    escapeText: escapeDiscord,
    buildLink: buildDiscordLink,
  });
}

export function markdownToDiscord(
  markdown: string,
  options: { tableMode?: MarkdownTableMode } = {},
): string {
  const ir = markdownToIR(markdown ?? "", {
    linkify: true,
    headingStyle: "none",
    blockquotePrefix: "> ",
    tableMode: options.tableMode,
  });
  return renderDiscordMarkdown(ir);
}

/**
 * Convert markdown to chunked Discord markdown strings.
 * Each chunk is ≤ `limit` characters of plain-text IR.
 */
export function markdownToDiscordChunks(
  markdown: string,
  limit: number = DISCORD_TEXT_LIMIT,
  options: { tableMode?: MarkdownTableMode } = {},
): string[] {
  const ir = markdownToIR(markdown ?? "", {
    linkify: true,
    headingStyle: "none",
    blockquotePrefix: "> ",
    tableMode: options.tableMode,
  });
  const chunks = chunkMarkdownIR(ir, limit);
  return chunks.map((chunk) => renderDiscordMarkdown(chunk));
}
