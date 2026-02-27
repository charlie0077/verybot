export type CommentQuestionType = "single" | "multi"

export interface CommentQuestionOption {
  id: string
  label: string
}

export interface CommentQuestion {
  id: string
  type: CommentQuestionType
  title: string
  contextTitle?: string
  contextBody?: string
  options: CommentQuestionOption[]
}

export interface ParsedCommentQuestions {
  markdown: string
  questions: CommentQuestion[]
  segments: ParsedCommentSegment[]
}

export type ParsedCommentSegment =
  | { type: "markdown"; content: string }
  | { type: "question"; question: CommentQuestion }

const QUESTION_BLOCK_MARKER = "```question"
const QUESTION_BLOCK_REGEX = /```question\s*\r?\n([\s\S]*?)```/gi
const NUMBERED_SECTION_HEADER_REGEX = /^(?:\s*#{1,6}\s*)?(?:q\s*)?\d+\s*[:.)-]\s+.+$/gim
const HEADING_PREFIX_REGEX = /^#{1,6}\s+/
const NUMBERED_PREFIX_REGEX = /^(?:q\s*)?\d+\s*[:.)-]\s+/i
const OPTIONS_KEY = "options:"
const QUESTION_ID_PREFIX = "question"
const OPTION_ID_PREFIX = "option"
const NEWLINE_COMPACT_REGEX = /\n{3,}/g
const THEMATIC_BREAK_LINE_REGEX = /^(?:-{3,}|\*{3,}|_{3,})\s*$/

export function parseCommentQuestions(content: string): ParsedCommentQuestions {
  if (!content.includes(QUESTION_BLOCK_MARKER)) {
    const markdown = content
    const segments: ParsedCommentSegment[] = markdown.trim()
      ? [{ type: "markdown", content: markdown }]
      : []
    return { markdown, questions: [], segments }
  }

  const rawSegments: ParsedCommentSegment[] = []
  const rawQuestions: CommentQuestion[] = []
  let lastIndex = 0
  let questionIndex = 0
  QUESTION_BLOCK_REGEX.lastIndex = 0
  let match = QUESTION_BLOCK_REGEX.exec(content)
  while (match) {
    const matchStart = match.index
    const matchEnd = QUESTION_BLOCK_REGEX.lastIndex
    const beforeBlock = content.slice(lastIndex, matchStart)
    if (beforeBlock.trim()) {
      rawSegments.push({ type: "markdown", content: normalizeMarkdownSpacing(beforeBlock) })
    }

    const parsedQuestion = parseQuestionBlock(match[1] ?? "", questionIndex)
    if (parsedQuestion) {
      rawQuestions.push(parsedQuestion)
      rawSegments.push({ type: "question", question: parsedQuestion })
      questionIndex += 1
    } else {
      // Keep malformed blocks visible as markdown so content never disappears.
      const rawBlock = content.slice(matchStart, matchEnd)
      if (rawBlock.trim()) {
        rawSegments.push({ type: "markdown", content: normalizeMarkdownSpacing(rawBlock) })
      }
    }

    lastIndex = matchEnd
    match = QUESTION_BLOCK_REGEX.exec(content)
  }

  const trailingMarkdown = content.slice(lastIndex)
  if (trailingMarkdown.trim()) {
    rawSegments.push({ type: "markdown", content: normalizeMarkdownSpacing(trailingMarkdown) })
  }

  const dedupedQuestions = dedupeQuestionIds(rawQuestions)
  const segments = rebindQuestionSegments(rawSegments, dedupedQuestions)
  const markdown = normalizeMarkdownSpacing(
    segments
      .filter((segment): segment is { type: "markdown"; content: string } => segment.type === "markdown")
      .map((segment) => segment.content)
      .join("\n\n"),
  )
  return { markdown, questions: dedupedQuestions, segments }
}

function normalizeMarkdownSpacing(markdown: string): string {
  return markdown.replace(NEWLINE_COMPACT_REGEX, "\n\n").trim()
}

export interface InlineQuestionLayout {
  markdownSegments: Array<{ type: "markdown"; content: string }>
  questions: CommentQuestion[]
}

export function buildInlineQuestionLayout(parsed: ParsedCommentQuestions): InlineQuestionLayout {
  if (parsed.questions.length === 0) {
    return {
      markdownSegments: parsed.segments
        .filter((segment): segment is { type: "markdown"; content: string } => segment.type === "markdown")
        .filter((segment) => segment.content.trim().length > 0),
      questions: [],
    }
  }

  const markdownSegments: Array<{ type: "markdown"; content: string }> = []
  const questions: CommentQuestion[] = []

  parsed.segments.forEach((segment) => {
    if (segment.type === "markdown") {
      const normalized = normalizeMarkdownSpacing(segment.content)
      if (normalized) {
        markdownSegments.push({ type: "markdown", content: normalized })
      }
      return
    }

    const previousMarkdown = markdownSegments[markdownSegments.length - 1]
    const extractedContext = previousMarkdown
      ? splitContextMarkdown(previousMarkdown.content)
      : { leadingMarkdown: "", contextMarkdown: "" }
    if (previousMarkdown) {
      if (extractedContext.leadingMarkdown) {
        previousMarkdown.content = extractedContext.leadingMarkdown
      } else {
        markdownSegments.pop()
      }
    }

    questions.push({
      ...segment.question,
      ...parseQuestionContextFromMarkdown(extractedContext.contextMarkdown),
    })
  })

  return {
    markdownSegments: markdownSegments.filter((segment) => segment.content.trim().length > 0),
    questions,
  }
}

function splitContextMarkdown(markdown: string): { leadingMarkdown: string; contextMarkdown: string } {
  const normalized = normalizeMarkdownSpacing(markdown)
  if (!normalized) return { leadingMarkdown: "", contextMarkdown: "" }

  NUMBERED_SECTION_HEADER_REGEX.lastIndex = 0
  let lastMatch: RegExpExecArray | null = null
  let match = NUMBERED_SECTION_HEADER_REGEX.exec(normalized)
  while (match) {
    lastMatch = match
    match = NUMBERED_SECTION_HEADER_REGEX.exec(normalized)
  }

  if (!lastMatch) {
    return {
      leadingMarkdown: normalized,
      contextMarkdown: "",
    }
  }

  return {
    leadingMarkdown: trimTrailingThematicBreaks(normalized.slice(0, lastMatch.index)),
    contextMarkdown: normalizeMarkdownSpacing(normalized.slice(lastMatch.index)),
  }
}

function trimTrailingThematicBreaks(markdown: string): string {
  const lines = markdown.split(/\r?\n/)
  let end = lines.length
  while (end > 0) {
    const line = lines[end - 1]?.trim() ?? ""
    if (!line) {
      end -= 1
      continue
    }
    if (THEMATIC_BREAK_LINE_REGEX.test(line)) {
      end -= 1
      continue
    }
    break
  }
  return normalizeMarkdownSpacing(lines.slice(0, end).join("\n"))
}

function parseQuestionContextFromMarkdown(markdown: string): Pick<CommentQuestion, "contextTitle" | "contextBody"> {
  const normalized = normalizeMarkdownSpacing(markdown)
  if (!normalized) return {}

  const lines = normalized.split(/\r?\n/)
  const firstNonEmptyLineIndex = lines.findIndex((line) => line.trim().length > 0)
  if (firstNonEmptyLineIndex < 0) return {}
  const firstLine = lines[firstNonEmptyLineIndex]!.trim()

  const hasHeaderPrefix = HEADING_PREFIX_REGEX.test(firstLine) || NUMBERED_PREFIX_REGEX.test(firstLine)
  if (!hasHeaderPrefix) {
    return {
      contextBody: normalized,
    }
  }

  const contextTitle = firstLine
    .replace(HEADING_PREFIX_REGEX, "")
    .replace(NUMBERED_PREFIX_REGEX, "")
    .trim()
  const contextBody = lines.slice(firstNonEmptyLineIndex + 1).join("\n").trim()

  return {
    contextTitle: contextTitle || undefined,
    contextBody: contextBody || undefined,
  }
}

function rebindQuestionSegments(
  rawSegments: ParsedCommentSegment[],
  dedupedQuestions: CommentQuestion[],
): ParsedCommentSegment[] {
  const segments: ParsedCommentSegment[] = []
  let questionCursor = 0
  rawSegments.forEach((segment) => {
    if (segment.type === "markdown") {
      if (segment.content.trim()) {
        segments.push({ type: "markdown", content: segment.content })
      }
      return
    }

    const nextQuestion = dedupedQuestions[questionCursor]
    questionCursor += 1
    if (nextQuestion) {
      segments.push({ type: "question", question: nextQuestion })
    }
  })
  return segments
}

function parseQuestionBlock(block: string, index: number): CommentQuestion | null {
  const lines = block.split(/\r?\n/)
  let id = ""
  let title = ""
  let type: CommentQuestionType = "single"
  const options: CommentQuestionOption[] = []
  let inOptions = false

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]?.trim() ?? ""
    if (!line) continue

    if (line.toLowerCase().startsWith("id:")) {
      id = normalizeIdentifier(readValue(line))
      inOptions = false
      continue
    }

    if (line.toLowerCase().startsWith("title:")) {
      title = stripWrappingQuotes(readValue(line))
      inOptions = false
      continue
    }

    if (line.toLowerCase().startsWith("type:")) {
      type = normalizeQuestionType(readValue(line))
      inOptions = false
      continue
    }

    if (line.toLowerCase() === OPTIONS_KEY) {
      inOptions = true
      continue
    }

    if (!inOptions || !line.startsWith("-")) continue
    const parsed = parseOption(lines, lineIndex, options.length)
    if (parsed.option) options.push(parsed.option)
    lineIndex = parsed.nextLineIndex - 1
  }

  const dedupedOptions = dedupeOptionIds(options)
  if (dedupedOptions.length === 0) return null

  const fallbackTitle = title || id || `${QUESTION_ID_PREFIX} ${index + 1}`
  const fallbackId = normalizeIdentifier(id || fallbackTitle) || `${QUESTION_ID_PREFIX}_${index + 1}`

  return {
    id: fallbackId,
    title: fallbackTitle,
    type,
    options: dedupedOptions,
  }
}

function parseOption(
  lines: string[],
  startLineIndex: number,
  optionIndex: number,
): { option: CommentQuestionOption | null; nextLineIndex: number } {
  const firstLine = lines[startLineIndex]?.trim().slice(1).trim() ?? ""
  let optionId = ""
  let optionLabel = ""

  if (firstLine.toLowerCase().startsWith("id:")) {
    optionId = normalizeIdentifier(readValue(firstLine))
  } else if (firstLine.toLowerCase().startsWith("label:")) {
    optionLabel = stripWrappingQuotes(readValue(firstLine))
  } else {
    const pipeIndex = firstLine.indexOf("|")
    if (pipeIndex >= 0) {
      optionId = normalizeIdentifier(firstLine.slice(0, pipeIndex).trim())
      optionLabel = stripWrappingQuotes(firstLine.slice(pipeIndex + 1).trim())
    } else {
      optionLabel = stripWrappingQuotes(firstLine)
    }
  }

  let currentLineIndex = startLineIndex + 1
  while (currentLineIndex < lines.length) {
    const line = lines[currentLineIndex]?.trim() ?? ""
    if (!line) {
      currentLineIndex += 1
      continue
    }
    if (line.startsWith("-")) break
    if (isQuestionLevelField(line)) break

    if (!optionId && line.toLowerCase().startsWith("id:")) {
      optionId = normalizeIdentifier(readValue(line))
    } else if (!optionLabel && line.toLowerCase().startsWith("label:")) {
      optionLabel = stripWrappingQuotes(readValue(line))
    }
    currentLineIndex += 1
  }

  const resolvedLabel = optionLabel || optionId
  if (!resolvedLabel) {
    return { option: null, nextLineIndex: currentLineIndex }
  }

  const resolvedId = optionId || normalizeIdentifier(resolvedLabel) || `${OPTION_ID_PREFIX}_${optionIndex + 1}`
  return {
    option: { id: resolvedId, label: resolvedLabel },
    nextLineIndex: currentLineIndex,
  }
}

function isQuestionLevelField(line: string): boolean {
  const normalized = line.toLowerCase()
  return normalized.startsWith("title:")
    || normalized.startsWith("type:")
    || normalized === OPTIONS_KEY
}

function dedupeQuestionIds(questions: CommentQuestion[]): CommentQuestion[] {
  const seenIds = new Set<string>()
  return questions.map((question, index) => {
    let nextId = question.id || `${QUESTION_ID_PREFIX}_${index + 1}`
    let suffix = 1
    while (seenIds.has(nextId)) {
      nextId = `${question.id}_${suffix}`
      suffix += 1
    }
    seenIds.add(nextId)
    return { ...question, id: nextId }
  })
}

function dedupeOptionIds(options: CommentQuestionOption[]): CommentQuestionOption[] {
  const seenIds = new Set<string>()
  return options.map((option, index) => {
    let nextId = option.id || `${OPTION_ID_PREFIX}_${index + 1}`
    let suffix = 1
    while (seenIds.has(nextId)) {
      nextId = `${option.id}_${suffix}`
      suffix += 1
    }
    seenIds.add(nextId)
    return { ...option, id: nextId }
  })
}

function normalizeQuestionType(rawValue: string): CommentQuestionType {
  const normalized = rawValue.trim().toLowerCase()
  return normalized === "multi" ? "multi" : "single"
}

function readValue(line: string): string {
  const separatorIndex = line.indexOf(":")
  if (separatorIndex < 0) return ""
  return line.slice(separatorIndex + 1).trim()
}

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length < 2) return trimmed
  const startsWithQuote = trimmed.startsWith('"') || trimmed.startsWith("'")
  const endsWithQuote = trimmed.endsWith('"') || trimmed.endsWith("'")
  if (startsWithQuote && endsWithQuote) {
    return trimmed.slice(1, -1).trim()
  }
  return trimmed
}

function normalizeIdentifier(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "")
  return normalized
}
