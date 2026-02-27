import type { TaskAttachment } from "./types"

const INLINE_IMAGE_MARKDOWN_PATTERN = /!\[([^\]]*)\]\(attachment:\/\/([^)]+)\)/g
export const INLINE_IMAGE_MARKER = "\u2063"

export interface InlineDescriptionTextSegment {
  type: "text"
  text: string
}

export interface InlineDescriptionImageSegment {
  type: "image"
  alt: string
  attachmentId: string
}

export type InlineDescriptionSegment = InlineDescriptionTextSegment | InlineDescriptionImageSegment

function sanitizeImageAltText(input: string): string {
  const cleaned = input.replace(/[\[\]\(\)]/g, " ").trim()
  return cleaned.length > 0 ? cleaned : "image"
}

function createInlineImageMarkdownLine(attachment: Pick<TaskAttachment, "id" | "name">): string {
  const alt = sanitizeImageAltText(attachment.name)
  return `![${alt}](attachment://${attachment.id})`
}

export function createInlineImageMarkdown(attachment: Pick<TaskAttachment, "id" | "name">): string {
  return `\n${createInlineImageMarkdownLine(attachment)}\n`
}

export function parseInlineDescription(description: string): InlineDescriptionSegment[] {
  if (!description.trim()) return []

  // Use a fresh regex instance per parse to avoid cross-call `lastIndex` glitches.
  const inlineImageMarkdownRegex = new RegExp(INLINE_IMAGE_MARKDOWN_PATTERN)
  const segments: InlineDescriptionSegment[] = []
  let lastIndex = 0

  for (const match of description.matchAll(inlineImageMarkdownRegex)) {
    const matchIndex = match.index ?? 0
    const [rawMatch, altText = "", attachmentId = ""] = match
    const leadingText = description.slice(lastIndex, matchIndex)
    if (leadingText) {
      segments.push({ type: "text", text: leadingText })
    }

    if (attachmentId.trim()) {
      segments.push({
        type: "image",
        alt: altText.trim() || "image",
        attachmentId: attachmentId.trim(),
      })
    }

    lastIndex = matchIndex + rawMatch.length
  }

  const trailingText = description.slice(lastIndex)
  if (trailingText) {
    segments.push({ type: "text", text: trailingText })
  }

  return segments
}

export function extractInlineImageAttachmentIds(description: string): string[] {
  return parseInlineDescription(description)
    .filter((segment) => segment.type === "image")
    .map((segment) => segment.attachmentId)
}

export function toEditorDescriptionWithInlineMarkers(description: string): {
  descriptionWithMarkers: string
  inlineAttachmentIds: string[]
} {
  const segments = parseInlineDescription(description)
  const inlineAttachmentIds: string[] = []

  const descriptionWithMarkers = segments
    .map((segment) => {
      if (segment.type === "text") return segment.text
      inlineAttachmentIds.push(segment.attachmentId)
      return INLINE_IMAGE_MARKER
    })
    .join("")

  return { descriptionWithMarkers, inlineAttachmentIds }
}

export function stripInlineImageMarkdown(description: string): string {
  const onlyText = parseInlineDescription(description)
    .filter((segment) => segment.type === "text")
    .map((segment) => segment.text)
    .join("")

  return onlyText
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

export function insertInlineImageMarkerAtSelection(
  value: string,
  selectionStart: number,
  selectionEnd: number,
): { nextValue: string; nextCursor: number; markerIndex: number } {
  const before = value.slice(0, selectionStart)
  const after = value.slice(selectionEnd)
  const markerIndex = (before.match(new RegExp(INLINE_IMAGE_MARKER, "g")) ?? []).length
  const nextValue = `${before}${INLINE_IMAGE_MARKER}${after}`
  const nextCursor = selectionStart + INLINE_IMAGE_MARKER.length
  return { nextValue, nextCursor, markerIndex }
}

export function removeInlineImageMarkerByIndex(value: string, markerIndex: number): string {
  let seenMarkerCount = 0
  let nextValue = ""

  for (const char of value) {
    if (char === INLINE_IMAGE_MARKER) {
      if (seenMarkerCount === markerIndex) {
        seenMarkerCount += 1
        continue
      }
      seenMarkerCount += 1
    }
    nextValue += char
  }

  return nextValue
}

export interface InlineEditorTextSegment {
  type: "text"
  text: string
}

export interface InlineEditorImageSegment {
  type: "image"
  attachment: TaskAttachment
  attachmentIndex: number
}

export type InlineEditorSegment = InlineEditorTextSegment | InlineEditorImageSegment

export function parseInlineEditorSegments(
  descriptionWithMarkers: string,
  attachments: TaskAttachment[],
): InlineEditorSegment[] {
  if (!descriptionWithMarkers.trim() && attachments.length === 0) return []

  const textParts = descriptionWithMarkers.split(INLINE_IMAGE_MARKER)
  const segments: InlineEditorSegment[] = []

  textParts.forEach((part, index) => {
    if (part) {
      segments.push({ type: "text", text: part })
    }

    const attachment = attachments[index]
    if (index < textParts.length - 1 && attachment) {
      segments.push({ type: "image", attachment, attachmentIndex: index })
    }
  })

  return segments
}

export function buildDescriptionWithInlineImages(
  text: string,
  attachments: Array<Pick<TaskAttachment, "id" | "name">>,
): string {
  const trimmedText = text.trim()

  if (trimmedText.includes(INLINE_IMAGE_MARKER)) {
    let attachmentIndex = 0
    return trimmedText
      .replaceAll(INLINE_IMAGE_MARKER, () => {
        const attachment = attachments[attachmentIndex]
        attachmentIndex += 1
        if (!attachment) return ""
        return `\n${createInlineImageMarkdownLine(attachment)}\n`
      })
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  }

  const imageSection = attachments
    .map((attachment) => createInlineImageMarkdownLine(attachment))
    .join("\n\n")

  if (trimmedText && imageSection) return `${trimmedText}\n\n${imageSection}`
  return trimmedText || imageSection
}
