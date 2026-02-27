/**
 * Markdown → WhatsApp text conversion.
 * WhatsApp formatting: *bold*, _italic_, ~strikethrough~, `code`, ```code block```
 * No link syntax — WhatsApp auto-linkifies URLs.
 */

import {
  chunkMarkdownIR,
  markdownToIR,
  type MarkdownIR,
  type MarkdownTableMode,
} from "../../markdown/ir.js";
import { renderMarkdownWithMarkers } from "../../markdown/render.js";

/** Characters that have formatting meaning in WhatsApp. */
const WA_SPECIAL = /[*_~`]/g;

export function escapeWhatsApp(text: string): string {
  return text.replace(WA_SPECIAL, "\\$&");
}

function renderWhatsApp(ir: MarkdownIR): string {
  return renderMarkdownWithMarkers(ir, {
    styleMarkers: {
      bold: { open: "*", close: "*" },
      italic: { open: "_", close: "_" },
      strikethrough: { open: "~", close: "~" },
      code: { open: "`", close: "`" },
      code_block: { open: "```\n", close: "\n```" },
    },
    escapeText: escapeWhatsApp,
    // No buildLink — WhatsApp auto-linkifies URLs
  });
}

/** Single-shot conversion (no chunking). */
export function markdownToWhatsApp(
  markdown: string,
  options: { tableMode?: MarkdownTableMode } = {},
): string {
  const ir = markdownToIR(markdown ?? "", {
    linkify: true,
    headingStyle: "none",
    blockquotePrefix: "",
    tableMode: options.tableMode,
  });
  return renderWhatsApp(ir);
}

/** WhatsApp message size limit. */
export const WHATSAPP_TEXT_LIMIT = 4096;

/**
 * Convert markdown to chunked WhatsApp text strings.
 * Each chunk is ≤ `limit` characters.
 */
export function markdownToWhatsAppChunks(
  markdown: string,
  limit: number,
  options: { tableMode?: MarkdownTableMode } = {},
): string[] {
  const ir = markdownToIR(markdown ?? "", {
    linkify: true,
    headingStyle: "none",
    blockquotePrefix: "",
    tableMode: options.tableMode,
  });
  const chunks = chunkMarkdownIR(ir, limit);
  return chunks.map((chunk) => renderWhatsApp(chunk));
}
