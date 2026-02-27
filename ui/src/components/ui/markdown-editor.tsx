import DOMPurify from "dompurify"
import MarkdownIt from "markdown-it"
import {
  useMemo,
  useLayoutEffect,
  useRef,
} from "react"

import { cn } from "@/lib/utils"
const EMPTY_EDITOR_BREAK = "<p><br></p>"
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

export interface MarkdownEditorProps {
  value: string
  placeholder: string
  className?: string
  onChange: (nextValue: string) => void
}

const MARKDOWN_PARSER = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
})

export function MarkdownEditor({
  value,
  placeholder,
  className,
  onChange,
}: MarkdownEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null)
  const pendingCursorOffsetRef = useRef<number | null>(null)
  const lastEmittedValueRef = useRef<string>("")
  const renderedHtml = useMemo(() => {
    if (!value.trim()) return ""
    const rendered = MARKDOWN_PARSER.render(value)
    return DOMPurify.sanitize(rendered)
  }, [value])

  function handleInput() {
    const editor = editorRef.current
    if (!editor) return

    const nextValue = htmlToMarkdown(editor).replace(/\r/g, "")
    const selection = getSelectionOffsets(editor)
    if (selection) pendingCursorOffsetRef.current = selection.end
    if (nextValue === value) return

    lastEmittedValueRef.current = nextValue
    onChange(nextValue)
  }

  useLayoutEffect(() => {
    const editor = editorRef.current
    if (!editor) return

    // Avoid resetting the DOM while user is typing into this editor.
    if (value !== lastEmittedValueRef.current) {
      editor.innerHTML = renderedHtml || EMPTY_EDITOR_BREAK
      lastEmittedValueRef.current = value
    }

    const pendingOffset = pendingCursorOffsetRef.current
    if (pendingOffset !== null) {
      pendingCursorOffsetRef.current = null
      setSelectionOffset(editor, pendingOffset)
    }
  }, [renderedHtml, value])

  return (
    <div className="relative">
      {!value.trim() && (
        <p className="pointer-events-none absolute top-0 left-0 text-muted-foreground/50">
          {placeholder}
        </p>
      )}
      <div
        ref={editorRef}
        data-slot="markdown-editor"
        contentEditable
        suppressContentEditableWarning
        className={cn(
          "markdown-body min-h-24 w-full break-words text-foreground outline-none",
          className,
        )}
        onInput={handleInput}
      />
    </div>
  )
}

function htmlToMarkdown(root: HTMLElement): string {
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

type TableCellAlignment = "left" | "center" | "right" | null

interface MarkdownTableCell {
  content: string
  alignment: TableCellAlignment
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

function getSelectionOffsets(root: HTMLElement): SelectionOffsets | null {
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
    start: readValueLength(startRange.cloneContents()),
    end: readValueLength(endRange.cloneContents()),
  }
}

interface SelectionOffsets {
  start: number
  end: number
}

function readValueLength(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) return (node.nodeValue ?? "").length
  if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return 0
  if (node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).tagName === "BR") return 1
  let length = 0
  node.childNodes.forEach((childNode) => {
    length += readValueLength(childNode)
  })
  return length
}

function getNodeLength(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.nodeValue?.length ?? 0
  }

  if (node.nodeType !== Node.ELEMENT_NODE) return 0

  const element = node as HTMLElement
  if (element.tagName === "BR") return 1

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
  if (element.tagName === "BR") {
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

  range.setStart(node, node.childNodes.length)
  range.collapse(true)
  return true
}
