import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react"
import DOMPurify from "dompurify"
import MarkdownIt from "markdown-it"
import { useGatewayContext } from "@/contexts/gateway-context"
import { cn } from "@/lib/utils"
import {
  INLINE_IMAGE_MARKER,
  removeInlineImageMarkerByIndex,
} from "./inline-image-markdown"
import { extractClipboardImageFiles } from "./task-image-input"
import type { TaskAttachment } from "./types"

const EMPTY_EDITOR_HTML = "<br />"
const INLINE_IMAGE_WRAPPER_CLASS_NAME = "group relative my-2 inline-block max-w-full overflow-hidden rounded-md border border-border align-middle"
const INLINE_IMAGE_CLASS_NAME = "max-h-96 w-full max-w-[32rem] object-cover"
const INLINE_IMAGE_FALLBACK_CLASS_NAME = "block aspect-video w-[18rem] max-w-full animate-pulse bg-muted"
const INLINE_IMAGE_REMOVE_BUTTON_CLASS_NAME = "absolute top-2 right-2 hidden size-5 items-center justify-center rounded-full bg-background/90 text-foreground ring-1 ring-border group-hover:flex"
const INLINE_IMAGE_REMOVE_ICON_CLASS_NAME = "text-xs leading-none"
const DEFAULT_INLINE_IMAGE_ALT = "image"
const INLINE_IMAGE_PLACEHOLDER_PREFIX = "TASKINLINEIMAGEPLACEHOLDER"
const INLINE_IMAGE_PLACEHOLDER_SUFFIX = "TOKEN"
const ALLOWED_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"])
const MARKDOWN_LINK_DESTINATION_NEEDS_BRACKETS = /[()<>\s]/
const BLOCK_TAG_NAMES = new Set([
  "ADDRESS",
  "ARTICLE",
  "ASIDE",
  "BLOCKQUOTE",
  "DETAILS",
  "DIALOG",
  "DIV",
  "DL",
  "FIELDSET",
  "FIGCAPTION",
  "FIGURE",
  "FOOTER",
  "FORM",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HEADER",
  "HR",
  "LI",
  "MAIN",
  "NAV",
  "OL",
  "P",
  "PRE",
  "SECTION",
  "TABLE",
  "UL",
])

const MARKDOWN_PARSER = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
})

interface AttachmentSrcCacheValue {
  escapedForHtmlAttribute: string
}

const attachmentSrcCache = new Map<string, AttachmentSrcCacheValue>()

function escapeHtml(rawValue: string): string {
  return rawValue
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;")
}

function renderMarkdownHtml(markdown: string): string {
  if (!markdown.trim()) return ""
  const rendered = MARKDOWN_PARSER.render(markdown)
  return DOMPurify.sanitize(rendered)
}

function buildInlineImageMarkerHtml(
  attachment: TaskAttachment | undefined,
  attachmentIndex: number,
  attachmentSrcById: Record<string, string | undefined>,
): string {
  const attachmentId = escapeHtml(attachment?.id ?? "")
  const attachmentName = escapeHtml(attachment?.name || DEFAULT_INLINE_IMAGE_ALT)
  const attachmentSrc = attachment ? attachmentSrcById[attachment.id] : undefined
  const imageContent = attachmentSrc
    ? `<img src="${attachmentSrc}" alt="${attachmentName}" class="${INLINE_IMAGE_CLASS_NAME}" />`
    : `<span class="${INLINE_IMAGE_FALLBACK_CLASS_NAME}"></span>`
  const removeButton = attachmentId
    ? (
      `<button type="button" aria-label="Remove image" data-inline-remove-index="${attachmentIndex}" data-inline-remove-id="${attachmentId}" class="${INLINE_IMAGE_REMOVE_BUTTON_CLASS_NAME}">`
      + `<span aria-hidden="true" class="${INLINE_IMAGE_REMOVE_ICON_CLASS_NAME}">x</span>`
      + "</button>"
    )
    : ""

  return (
    `<span contenteditable="false" data-inline-image-marker="true" data-attachment-id="${attachmentId}" class="${INLINE_IMAGE_WRAPPER_CLASS_NAME}">`
    + imageContent
    + removeButton
    + "</span>"
  )
}

function buildEditorHtml(
  value: string,
  attachments: TaskAttachment[],
  attachmentSrcById: Record<string, string | undefined>,
): string {
  if (!value.trim() && attachments.length === 0) return EMPTY_EDITOR_HTML

  let markerCount = 0
  const markdownWithPlaceholders = value.replaceAll(INLINE_IMAGE_MARKER, () => {
    const placeholder = `${INLINE_IMAGE_PLACEHOLDER_PREFIX}${markerCount}${INLINE_IMAGE_PLACEHOLDER_SUFFIX}`
    markerCount += 1
    return placeholder
  })

  let renderedHtml = renderMarkdownHtml(markdownWithPlaceholders)
  if (!renderedHtml) return EMPTY_EDITOR_HTML

  for (let markerIndex = 0; markerIndex < markerCount; markerIndex += 1) {
    const placeholder = `${INLINE_IMAGE_PLACEHOLDER_PREFIX}${markerIndex}${INLINE_IMAGE_PLACEHOLDER_SUFFIX}`
    const markerHtml = buildInlineImageMarkerHtml(
      attachments[markerIndex],
      markerIndex,
      attachmentSrcById,
    )
    renderedHtml = renderedHtml.replaceAll(placeholder, markerHtml)
  }

  return renderedHtml.replace(
    new RegExp(`${INLINE_IMAGE_PLACEHOLDER_PREFIX}\\d+${INLINE_IMAGE_PLACEHOLDER_SUFFIX}`, "g"),
    "",
  )
}

function useInlineAttachmentSrcById(attachments: TaskAttachment[]): Record<string, string | undefined> {
  const { rpc } = useGatewayContext()
  const [refreshVersion, setRefreshVersion] = useState(0)
  const attachmentIds = useMemo(
    () => Array.from(new Set(attachments.map((attachment) => attachment.id))),
    [attachments],
  )

  useEffect(() => {
    let cancelled = false
    const missingAttachmentIds = attachmentIds.filter((attachmentId) => !attachmentSrcCache.has(attachmentId))
    if (missingAttachmentIds.length === 0) return () => { cancelled = true }

    for (const attachmentId of missingAttachmentIds) {
      void rpc("tasks.getAttachment", { id: attachmentId })
        .then((response) => {
          if (cancelled) return
          const { data, type } = response as { data: string; type: string }
          const attachmentSrc = `data:${type};base64,${data}`
          attachmentSrcCache.set(attachmentId, {
            escapedForHtmlAttribute: escapeHtml(attachmentSrc),
          })
          setRefreshVersion((previousVersion) => previousVersion + 1)
        })
        .catch(() => {
          if (cancelled) return
          attachmentSrcCache.set(attachmentId, {
            escapedForHtmlAttribute: "",
          })
          setRefreshVersion((previousVersion) => previousVersion + 1)
        })
    }

    return () => { cancelled = true }
  }, [attachmentIds, rpc])

  // Recompute on rerender when async fetches bump refreshVersion.
  void refreshVersion
  const srcById: Record<string, string | undefined> = {}
  for (const attachmentId of attachmentIds) {
    const cachedSrc = attachmentSrcCache.get(attachmentId)
    if (!cachedSrc) continue
    srcById[attachmentId] = cachedSrc.escapedForHtmlAttribute
  }
  return srcById
}

export interface TaskDescriptionEditorHandle {
  focus: () => void
  insertInlineImageMarkerAtCursor: () => number
}

export interface TaskDescriptionEditorProps {
  value: string
  attachments: TaskAttachment[]
  placeholder: string
  className?: string
  onChange: (nextValue: string) => void
  onRemoveImageAtIndex: (attachmentIndex: number, attachmentId: string) => void
  onPasteImages?: (files: File[]) => void | Promise<void>
  onBlur?: () => void
}

export const TaskDescriptionEditor = forwardRef<TaskDescriptionEditorHandle, TaskDescriptionEditorProps>(
  function TaskDescriptionEditor(
    {
      value,
      attachments,
      placeholder,
      className,
      onChange,
      onRemoveImageAtIndex,
      onPasteImages,
      onBlur,
    },
    ref,
  ) {
    const editorRef = useRef<HTMLDivElement>(null)
    const pendingCursorOffsetRef = useRef<number | null>(null)
    const lastSelectionOffsetRef = useRef<number | null>(null)
    const hasInitializedDomRef = useRef(false)
    const lastEmittedValueRef = useRef(value)
    const lastAppliedAttachmentSignatureRef = useRef("")
    const lastAppliedAttachmentSrcSignatureRef = useRef("")
    const attachmentSrcById = useInlineAttachmentSrcById(attachments)
    const attachmentSignature = useMemo(
      () => attachments.map((attachment) => attachment.id).join("|"),
      [attachments],
    )
    const attachmentSrcSignature = useMemo(
      () => attachments
        .map((attachment) => `${attachment.id}:${attachmentSrcById[attachment.id] ? "1" : "0"}`)
        .join("|"),
      [attachments, attachmentSrcById],
    )
    const editorHtml = useMemo(
      () => buildEditorHtml(value, attachments, attachmentSrcById),
      [value, attachments, attachmentSrcById],
    )
    const isEmpty = value.length === 0 && attachments.length === 0

    const removeImageAtIndex = useCallback((index: number, attachmentId: string) => {
      const nextValue = removeInlineImageMarkerByIndex(value, index)
      const editor = editorRef.current
      const renderedValue = editor ? readRenderedValueFromNode(editor).replace(/\r/g, "") : value
      const markerOffset = getInlineMarkerOffsetByIndex(renderedValue, index)
      pendingCursorOffsetRef.current = markerOffset
      lastSelectionOffsetRef.current = markerOffset
      lastEmittedValueRef.current = nextValue
      onChange(nextValue)
      onRemoveImageAtIndex(index, attachmentId)
      requestAnimationFrame(() => {
        editorRef.current?.focus()
      })
    }, [onChange, onRemoveImageAtIndex, value])

    function handleInput() {
      const editor = editorRef.current
      if (!editor) return
      const nextValue = readMarkdownValueFromNode(editor).replace(/\r/g, "")
      const selectionAfterInput = getSelectionOffsets(editor)
      if (selectionAfterInput) {
        lastSelectionOffsetRef.current = selectionAfterInput.end
      }
      if (nextValue === value) return

      const removedMarkerIndexes = getRemovedMarkerIndexesFromValueDiff(value, nextValue)

      lastEmittedValueRef.current = nextValue
      onChange(nextValue)
      removeAttachmentsByIndexesDescending(removedMarkerIndexes)
    }

    function rememberSelectionOffset() {
      const editor = editorRef.current
      if (!editor) return
      const selection = getSelectionOffsets(editor)
      if (!selection) return
      lastSelectionOffsetRef.current = selection.end
    }

    function removeAttachmentsByIndexesDescending(markerIndexes: number[]) {
      const descendingMarkerIndexes = [...markerIndexes]
        .sort((first, second) => second - first)
      for (const markerIndex of descendingMarkerIndexes) {
        const attachment = attachments[markerIndex]
        if (!attachment) continue
        onRemoveImageAtIndex(markerIndex, attachment.id)
      }
    }

    async function handlePaste(e: ClipboardEvent<HTMLDivElement>) {
      const imageFiles = extractClipboardImageFiles(e.clipboardData)
      if (imageFiles.length === 0 || !onPasteImages) return
      e.preventDefault()
      await onPasteImages(imageFiles)
    }

    const handleEditorClick = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement
      const link = target.closest<HTMLAnchorElement>("a[href]")
      if (link) {
        e.preventDefault()
        const href = link.getAttribute("href")?.trim()
        if (!href) return
        const safeHref = resolveSafeLinkHref(href)
        if (!safeHref) return
        window.open(safeHref, "_blank", "noopener,noreferrer")
        return
      }

      const removeButton = target.closest<HTMLElement>("[data-inline-remove-index]")
      if (!removeButton) return

      e.preventDefault()
      const markerIndexRaw = removeButton.dataset.inlineRemoveIndex
      const attachmentId = removeButton.dataset.inlineRemoveId
      if (!markerIndexRaw || !attachmentId) return

      const markerIndex = Number.parseInt(markerIndexRaw, 10)
      if (Number.isNaN(markerIndex) || markerIndex < 0) return
      removeImageAtIndex(markerIndex, attachmentId)
    }, [removeImageAtIndex])

    useImperativeHandle(ref, () => ({
      focus: () => {
        editorRef.current?.focus()
      },
      insertInlineImageMarkerAtCursor: () => {
        const editor = editorRef.current
        if (!editor) {
          const markerIndex = countInlineMarkersBeforeOffset(value, value.length)
          const nextValue = `${value}${INLINE_IMAGE_MARKER}`
          lastEmittedValueRef.current = nextValue
          onChange(nextValue)
          return markerIndex
        }

        const visibleValue = readRenderedValueFromNode(editor).replace(/\r/g, "")
        const browserSelection = window.getSelection()
        let activeRange = browserSelection && browserSelection.rangeCount > 0
          ? browserSelection.getRangeAt(0)
          : null
        const hasActiveRangeInEditor = Boolean(
          activeRange
          && editor.contains(activeRange.startContainer)
          && editor.contains(activeRange.endContainer),
        )

        if (!hasActiveRangeInEditor && lastSelectionOffsetRef.current !== null) {
          const restoredOffset = Math.min(lastSelectionOffsetRef.current, visibleValue.length)
          setSelectionOffset(editor, restoredOffset)
          const restoredSelection = window.getSelection()
          activeRange = restoredSelection && restoredSelection.rangeCount > 0
            ? restoredSelection.getRangeAt(0)
            : null
        }

        const selection = getSelectionOffsets(editor)
        const selectionStart = selection?.start ?? visibleValue.length
        const markerIndex = countInlineMarkersBeforeOffset(visibleValue, selectionStart)

        if (
          activeRange
          && editor.contains(activeRange.startContainer)
          && editor.contains(activeRange.endContainer)
        ) {
          const insertionRange = activeRange.cloneRange()
          insertionRange.deleteContents()
          const markerNode = document.createTextNode(INLINE_IMAGE_MARKER)
          insertionRange.insertNode(markerNode)
          insertionRange.setStartAfter(markerNode)
          insertionRange.collapse(true)
          browserSelection?.removeAllRanges()
          browserSelection?.addRange(insertionRange)
        } else {
          editor.append(document.createTextNode(INLINE_IMAGE_MARKER))
        }

        const nextCursorOffset = selectionStart + 1
        pendingCursorOffsetRef.current = nextCursorOffset
        lastSelectionOffsetRef.current = nextCursorOffset
        const nextValue = readMarkdownValueFromNode(editor).replace(/\r/g, "")
        lastEmittedValueRef.current = nextValue
        onChange(nextValue)
        return markerIndex
      },
    }), [onChange, value])

    useLayoutEffect(() => {
      const editor = editorRef.current
      if (!editor) return

      const selectionBeforeSync = getSelectionOffsets(editor)
      const preservedSelectionOffset = selectionBeforeSync?.end ?? lastSelectionOffsetRef.current
      const hasExternalValueChange = value !== lastEmittedValueRef.current
      const hasAttachmentBindingChange = attachmentSignature !== lastAppliedAttachmentSignatureRef.current
      const hasAttachmentSrcChange = attachmentSrcSignature !== lastAppliedAttachmentSrcSignatureRef.current
      const shouldSyncDomFromProps = (
        !hasInitializedDomRef.current
        || hasAttachmentBindingChange
        || hasAttachmentSrcChange
        || hasExternalValueChange
      )

      if (shouldSyncDomFromProps) {
        editor.innerHTML = editorHtml || EMPTY_EDITOR_HTML
        hasInitializedDomRef.current = true
        lastEmittedValueRef.current = value
        lastAppliedAttachmentSignatureRef.current = attachmentSignature
        lastAppliedAttachmentSrcSignatureRef.current = attachmentSrcSignature
        if (preservedSelectionOffset !== null && preservedSelectionOffset !== undefined) {
          pendingCursorOffsetRef.current = preservedSelectionOffset
        }
      }

      const pendingCursorOffset = pendingCursorOffsetRef.current
      if (pendingCursorOffset === null) return
      pendingCursorOffsetRef.current = null
      const renderedValueLength = readRenderedValueFromNode(editor).length
      const clampedOffset = Math.max(0, Math.min(pendingCursorOffset, renderedValueLength))
      editor.focus()
      setSelectionOffset(editor, clampedOffset)
      lastSelectionOffsetRef.current = clampedOffset
    }, [value, attachmentSignature, attachmentSrcSignature, editorHtml])

    return (
      <div className="relative">
        {isEmpty && (
          <p className="pointer-events-none absolute top-0 left-0 text-muted-foreground/50">
            {placeholder}
          </p>
        )}
        <div
          ref={editorRef}
          contentEditable
          suppressContentEditableWarning
          className={cn(
            "markdown-body min-h-24 w-full break-words bg-transparent text-foreground outline-none",
            className,
          )}
          onInput={handleInput}
          onPaste={(e) => { void handlePaste(e) }}
          onClick={handleEditorClick}
          onMouseUp={rememberSelectionOffset}
          onKeyUp={rememberSelectionOffset}
          onFocus={rememberSelectionOffset}
          onBlur={onBlur}
        />
      </div>
    )
  },
)

function countInlineMarkersBeforeOffset(value: string, offset: number): number {
  let markerCount = 0
  for (let index = 0; index < offset; index += 1) {
    if (value[index] === INLINE_IMAGE_MARKER) markerCount += 1
  }
  return markerCount
}

function getInlineMarkerIndexesInRange(value: string, start: number, end: number): number[] {
  const markerIndexes: number[] = []
  let markerIndex = 0

  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== INLINE_IMAGE_MARKER) continue
    if (index >= start && index < end) markerIndexes.push(markerIndex)
    markerIndex += 1
  }

  return markerIndexes
}

function getInlineMarkerOffsetByIndex(value: string, targetMarkerIndex: number): number {
  let markerIndex = 0

  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== INLINE_IMAGE_MARKER) continue
    if (markerIndex === targetMarkerIndex) return index
    markerIndex += 1
  }

  return value.length
}

function countInlineMarkers(value: string): number {
  let markerCount = 0
  for (const char of value) {
    if (char === INLINE_IMAGE_MARKER) markerCount += 1
  }
  return markerCount
}

function getChangedRange(previousValue: string, nextValue: string): { start: number; previousEnd: number } {
  let start = 0
  while (
    start < previousValue.length
    && start < nextValue.length
    && previousValue[start] === nextValue[start]
  ) {
    start += 1
  }

  let previousEnd = previousValue.length
  let nextEnd = nextValue.length
  while (
    previousEnd > start
    && nextEnd > start
    && previousValue[previousEnd - 1] === nextValue[nextEnd - 1]
  ) {
    previousEnd -= 1
    nextEnd -= 1
  }

  return { start, previousEnd }
}

function getRemovedMarkerIndexesFromValueDiff(previousValue: string, nextValue: string): number[] {
  const previousMarkerCount = countInlineMarkers(previousValue)
  const nextMarkerCount = countInlineMarkers(nextValue)
  if (nextMarkerCount >= previousMarkerCount) return []

  const { start, previousEnd } = getChangedRange(previousValue, nextValue)
  const removedMarkerIndexes = getInlineMarkerIndexesInRange(previousValue, start, previousEnd)
  if (removedMarkerIndexes.length > 0) return removedMarkerIndexes

  const removedCount = previousMarkerCount - nextMarkerCount
  return Array.from({ length: removedCount }, (_, index) => nextMarkerCount + index)
}

function readRenderedValueFromNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.nodeValue ?? ""
  }

  if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) {
    return ""
  }

  if (node.nodeType === Node.ELEMENT_NODE) {
    const element = node as HTMLElement
    if (element.dataset.inlineImageMarker === "true") {
      return INLINE_IMAGE_MARKER
    }
    if (element.tagName === "BR") {
      return "\n"
    }
  }

  let value = ""
  node.childNodes.forEach((childNode) => {
    value += readRenderedValueFromNode(childNode)
  })
  return value
}

function readMarkdownValueFromNode(root: HTMLElement): string {
  return htmlNodeToMarkdown(root)
}

function htmlNodeToMarkdown(root: HTMLElement): string {
  const blocks: string[] = []
  for (const node of Array.from(root.childNodes)) {
    const block = blockNodeToMarkdown(node).trimEnd()
    if (block) blocks.push(block)
  }
  return normalizeMarkdown(blocks.join("\n\n"))
}

function blockNodeToMarkdown(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return normalizeText(node.nodeValue ?? "")
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    return ""
  }

  const element = node as HTMLElement
  if (element.dataset.inlineImageMarker === "true") return INLINE_IMAGE_MARKER
  const tagName = element.tagName.toUpperCase()

  if (tagName === "BR") return ""

  if (/^H[1-6]$/.test(tagName)) {
    const level = Number(tagName[1] ?? "1")
    const content = inlineChildrenToMarkdown(element).trim()
    if (!content) return ""
    return `${"#".repeat(level)} ${content}`
  }

  if (tagName === "P") {
    return inlineChildrenToMarkdown(element).trim()
  }

  if (tagName === "UL") {
    const items = Array.from(element.children)
      .filter((child) => child.tagName.toUpperCase() === "LI")
      .map((child) => `- ${inlineChildrenToMarkdown(child).trim()}`)
      .filter((item) => item !== "-")
    return items.join("\n")
  }

  if (tagName === "OL") {
    const items = Array.from(element.children)
      .filter((child) => child.tagName.toUpperCase() === "LI")
      .map((child, index) => `${index + 1}. ${inlineChildrenToMarkdown(child).trim()}`)
      .filter((item) => !item.endsWith("."))
    return items.join("\n")
  }

  if (tagName === "PRE") {
    const code = element.querySelector("code")
    const codeText = normalizeText((code?.textContent ?? element.textContent ?? "").replace(/\n$/, ""))
    if (!codeText.trim()) return ""
    return `\`\`\`\n${codeText}\n\`\`\``
  }

  if (tagName === "BLOCKQUOTE") {
    const inner = Array.from(element.childNodes)
      .map((child) => blockNodeToMarkdown(child))
      .join("\n")
      .trim()
    if (!inner) return ""
    return inner
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n")
  }

  if (tagName === "HR") return "---"
  if (tagName === "TABLE") return tableToMarkdown(element)

  if (tagName === "DIV") {
    const children = Array.from(element.childNodes)
    if (children.length === 1 && (children[0] as HTMLElement)?.tagName?.toUpperCase?.() === "BR") {
      return ""
    }
    if (children.some((child) => child.nodeType === Node.ELEMENT_NODE)) {
      return children.map((child) => blockNodeToMarkdown(child)).join("\n").trim()
    }
    return inlineChildrenToMarkdown(element).trim()
  }

  const nestedBlocks = Array.from(element.childNodes)
    .map((child) => blockNodeToMarkdown(child))
    .filter(Boolean)
  if (nestedBlocks.length > 0) {
    const hasBlockChild = Array.from(element.childNodes).some((child) => {
      if (child.nodeType !== Node.ELEMENT_NODE) return false
      return BLOCK_TAG_NAMES.has((child as HTMLElement).tagName.toUpperCase())
    })
    return nestedBlocks.join(hasBlockChild ? "\n\n" : "\n")
  }

  return inlineChildrenToMarkdown(element).trim()
}

function inlineChildrenToMarkdown(element: Element): string {
  let value = ""
  element.childNodes.forEach((childNode) => {
    value += inlineNodeToMarkdown(childNode)
  })
  return value
}

function inlineNodeToMarkdown(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return normalizeText(node.nodeValue ?? "")
  }

  if (node.nodeType !== Node.ELEMENT_NODE) return ""

  const element = node as HTMLElement
  if (element.dataset.inlineImageMarker === "true") return INLINE_IMAGE_MARKER
  const tagName = element.tagName.toUpperCase()

  if (tagName === "BR") return "\n"
  if (tagName === "STRONG" || tagName === "B") return `**${inlineChildrenToMarkdown(element)}**`
  if (tagName === "EM" || tagName === "I") return `*${inlineChildrenToMarkdown(element)}*`
  if (tagName === "DEL" || tagName === "S") return `~~${inlineChildrenToMarkdown(element)}~~`
  if (tagName === "CODE") return `\`${normalizeText(element.textContent ?? "")}\``
  if (tagName === "A") {
    const href = element.getAttribute("href") ?? ""
    const text = inlineChildrenToMarkdown(element).trim() || href
    return href ? `[${text}](${href})` : text
  }
  if (tagName === "IMG") {
    const src = normalizeText(element.getAttribute("src") ?? "").trim()
    if (!src) return ""

    const alt = escapeMarkdownLabel(element.getAttribute("alt") ?? "")
    const destination = formatMarkdownDestination(src)
    if (!destination) return ""

    const title = normalizeText(element.getAttribute("title") ?? "").trim()
    if (!title) return `![${alt}](${destination})`
    return `![${alt}](${destination} "${escapeMarkdownTitle(title)}")`
  }

  return inlineChildrenToMarkdown(element)
}

type TableCellAlignment = "left" | "center" | "right" | null

interface MarkdownTableCell {
  content: string
  alignment: TableCellAlignment
}

function tableToMarkdown(tableElement: HTMLElement): string {
  const tableRows = Array.from(tableElement.querySelectorAll("tr"))
    .map((rowElement) => tableRowToMarkdownCells(rowElement))
    .filter((row) => row.length > 0)
  if (tableRows.length === 0) return ""

  const headerRow = tableRows[0] ?? []
  const bodyRows = tableRows.slice(1)
  const columnCount = Math.max(
    headerRow.length,
    ...bodyRows.map((row) => row.length),
  )
  if (columnCount === 0) return ""

  const alignedRows = [headerRow, ...bodyRows].map((row) => padTableRow(row, columnCount))
  const tableAlignments = Array.from({ length: columnCount }, (_, columnIndex) => {
    for (const row of alignedRows) {
      const alignment = row[columnIndex]?.alignment
      if (alignment) return alignment
    }
    return null
  })

  const markdownLines = [
    formatMarkdownTableRow(alignedRows[0] ?? []),
    formatMarkdownTableRow(tableAlignments.map((alignment) => tableAlignmentToDivider(alignment))),
    ...alignedRows.slice(1).map((row) => formatMarkdownTableRow(row.map((cell) => cell.content))),
  ]
  return markdownLines.join("\n")
}

function tableRowToMarkdownCells(rowElement: HTMLTableRowElement): MarkdownTableCell[] {
  const rowCells = Array.from(rowElement.cells)
  return rowCells.map((cellElement) => ({
    content: toMarkdownTableCellContent(cellElement),
    alignment: readTableCellAlignment(cellElement),
  }))
}

function padTableRow(row: MarkdownTableCell[], columnCount: number): MarkdownTableCell[] {
  const paddedRow = [...row]
  while (paddedRow.length < columnCount) {
    paddedRow.push({ content: "", alignment: null })
  }
  return paddedRow
}

function formatMarkdownTableRow(cells: (string | MarkdownTableCell)[]): string {
  const rowContent = cells.map((cell) => {
    if (typeof cell === "string") return cell
    return cell.content
  })
  return `| ${rowContent.join(" | ")} |`
}

function toMarkdownTableCellContent(cellElement: HTMLTableCellElement): string {
  const inlineValue = inlineChildrenToMarkdown(cellElement).trim()
  const fallbackValue = normalizeText(cellElement.textContent ?? "").trim()
  const value = inlineValue || fallbackValue
  return value
    .replace(/\r/g, "")
    .replace(/\n+/g, "<br />")
    .replaceAll("|", "\\|")
}

function readTableCellAlignment(cellElement: HTMLTableCellElement): TableCellAlignment {
  const alignAttribute = normalizeText(cellElement.getAttribute("align") ?? "").trim().toLowerCase()
  if (alignAttribute === "left" || alignAttribute === "center" || alignAttribute === "right") {
    return alignAttribute
  }

  const styleText = normalizeText(cellElement.getAttribute("style") ?? "").toLowerCase()
  const styleMatch = styleText.match(/text-align\s*:\s*(left|center|right)/)
  if (styleMatch?.[1] === "left" || styleMatch?.[1] === "center" || styleMatch?.[1] === "right") {
    return styleMatch[1]
  }

  return null
}

function tableAlignmentToDivider(alignment: TableCellAlignment): string {
  if (alignment === "left") return ":---"
  if (alignment === "center") return ":---:"
  if (alignment === "right") return "---:"
  return "---"
}

function escapeMarkdownLabel(value: string): string {
  return normalizeText(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("]", "\\]")
}

function escapeMarkdownTitle(value: string): string {
  return normalizeText(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("\"", "\\\"")
}

function formatMarkdownDestination(value: string): string {
  const normalizedDestination = normalizeText(value).trim()
  if (!normalizedDestination) return ""
  if (!MARKDOWN_LINK_DESTINATION_NEEDS_BRACKETS.test(normalizedDestination)) {
    return normalizedDestination
  }
  return `<${normalizedDestination.replaceAll(">", "\\>")}>`
}

function normalizeText(value: string): string {
  return value.replace(/\u00A0/g, " ")
}

function normalizeMarkdown(value: string): string {
  return value
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim()
}

function resolveSafeLinkHref(rawHref: string): string | null {
  try {
    const url = new URL(rawHref, window.location.href)
    if (!ALLOWED_LINK_PROTOCOLS.has(url.protocol)) return null
    return url.toString()
  } catch {
    return null
  }
}

function getSelectionOffsets(root: HTMLElement): { start: number; end: number } | null {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return null
  const range = selection.getRangeAt(0)

  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null

  const startRange = range.cloneRange()
  startRange.selectNodeContents(root)
  startRange.setEnd(range.startContainer, range.startOffset)
  const endRange = range.cloneRange()
  endRange.selectNodeContents(root)
  endRange.setEnd(range.endContainer, range.endOffset)

  return {
    start: readRenderedValueFromNode(startRange.cloneContents()).length,
    end: readRenderedValueFromNode(endRange.cloneContents()).length,
  }
}

function getNodeLength(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.nodeValue?.length ?? 0
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return 0
  }

  const element = node as HTMLElement
  if (element.dataset.inlineImageMarker === "true") {
    return 1
  }
  if (element.tagName === "BR") {
    return 1
  }

  let length = 0
  element.childNodes.forEach((childNode) => {
    length += getNodeLength(childNode)
  })
  return length
}

function setSelectionOffset(root: HTMLElement, targetOffset: number) {
  const selection = window.getSelection()
  if (!selection) return

  const range = document.createRange()

  const placed = placeRangeAtOffset(root, range, targetOffset)
  if (!placed) {
    range.selectNodeContents(root)
    range.collapse(false)
  }

  selection.removeAllRanges()
  selection.addRange(range)
}

function placeRangeAtOffset(node: Node, range: Range, offset: number): boolean {
  if (node.nodeType === Node.TEXT_NODE) {
    const textLength = node.nodeValue?.length ?? 0
    const textOffset = Math.min(offset, textLength)
    range.setStart(node, textOffset)
    range.collapse(true)
    return true
  }

  if (node.nodeType !== Node.ELEMENT_NODE) return false

  const element = node as HTMLElement
  if (element.dataset.inlineImageMarker === "true") {
    if (offset <= 0) {
      range.setStartBefore(element)
      range.collapse(true)
      return true
    }
    range.setStartAfter(element)
    range.collapse(true)
    return true
  }

  let remaining = offset
  for (const childNode of Array.from(node.childNodes)) {
    const childLength = getNodeLength(childNode)
    if (remaining <= childLength) {
      return placeRangeAtOffset(childNode, range, remaining)
    }
    remaining -= childLength
  }

  if (node.childNodes.length === 0) {
    range.setStart(node, 0)
    range.collapse(true)
    return true
  }

  range.setStart(node, node.childNodes.length)
  range.collapse(true)
  return true
}
