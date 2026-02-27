/**
 * Table mode resolution for markdown rendering.
 * Adapted from verybot markdown-tables.
 */

import type { MarkdownTableMode } from "./ir.js";

/** Per-channel defaults. */
const DEFAULT_TABLE_MODES = new Map<string, MarkdownTableMode>([
  ["signal", "bullets"],
  ["whatsapp", "bullets"],
]);

/** Fallback for channels not in the default map. */
const GLOBAL_DEFAULT: MarkdownTableMode = "code";

const isMarkdownTableMode = (value: unknown): value is MarkdownTableMode =>
  value === "off" || value === "bullets" || value === "code";

/**
 * Resolve the markdown table mode for a given channel.
 *
 * Resolution order:
 *   1. Explicit per-channel config (`channelTableMode`)
 *   2. Channel-specific default (signal/whatsapp → "bullets")
 *   3. Global default ("code")
 */
export function resolveMarkdownTableMode(params: {
  channel: string;
  channelTableMode?: MarkdownTableMode | string | null;
}): MarkdownTableMode {
  const { channel, channelTableMode } = params;
  if (isMarkdownTableMode(channelTableMode)) {
    return channelTableMode;
  }
  return DEFAULT_TABLE_MODES.get(channel) ?? GLOBAL_DEFAULT;
}
