import { readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { ATTACHMENTS_DIR } from "../paths.js";
import { EXT_FOR_MIME } from "./types.js";

const INLINE_TASK_ATTACHMENT_MARKDOWN_PATTERN = /!\[[^\]]*\]\(attachment:\/\/([^)]+)\)/g;
const INLINE_TASK_ATTACHMENT_PLACEHOLDER = "[image attached]";

const MIME_FOR_EXT: Record<string, string> = Object.fromEntries(
  Object.entries(EXT_FOR_MIME).map(([mime, ext]) => [ext.toLowerCase(), mime]),
);

export interface InlineAttachmentContentResolution {
  normalizedText: string;
  imageDataUrls: string[];
}

function extractInlineAttachmentIds(text: string): string[] {
  const ids: string[] = [];
  const seenIds = new Set<string>();

  for (const match of text.matchAll(INLINE_TASK_ATTACHMENT_MARKDOWN_PATTERN)) {
    const rawId = (match[1] ?? "").trim();
    if (!rawId || seenIds.has(rawId)) continue;
    seenIds.add(rawId);
    ids.push(rawId);
  }

  return ids;
}

function normalizeAttachmentId(rawId: string): string | null {
  const candidate = rawId.trim();
  const safe = basename(candidate);
  if (!safe || safe !== candidate || safe.startsWith(".")) return null;
  return safe;
}

function resolveMimeType(fileName: string): string {
  const extension = extname(fileName).toLowerCase();
  return MIME_FOR_EXT[extension] ?? "application/octet-stream";
}

async function readAttachmentAsDataUrl(rawId: string): Promise<string | null> {
  const safeId = normalizeAttachmentId(rawId);
  if (!safeId) return null;

  try {
    const filePath = join(ATTACHMENTS_DIR, safeId);
    const content = await readFile(filePath);
    const mimeType = resolveMimeType(safeId);
    return `data:${mimeType};base64,${content.toString("base64")}`;
  } catch {
    return null;
  }
}

function replaceInlineAttachmentMarkdown(text: string): string {
  return text
    .replace(INLINE_TASK_ATTACHMENT_MARKDOWN_PATTERN, INLINE_TASK_ATTACHMENT_PLACEHOLDER)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Resolve `attachment://...` markdown references in text into image data URLs.
 * The returned text replaces inline attachment markdown with `[image attached]`.
 */
export async function resolveInlineAttachmentContent(
  text: string,
): Promise<InlineAttachmentContentResolution> {
  const attachmentIds = extractInlineAttachmentIds(text);
  if (attachmentIds.length === 0) {
    return { normalizedText: text, imageDataUrls: [] };
  }

  const resolvedImages = await Promise.all(
    attachmentIds.map((attachmentId) => readAttachmentAsDataUrl(attachmentId)),
  );
  const imageDataUrls = resolvedImages.filter((url): url is string => Boolean(url));
  const normalizedText = replaceInlineAttachmentMarkdown(text);

  return { normalizedText, imageDataUrls };
}
