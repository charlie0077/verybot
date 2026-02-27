import { memo, useState, useRef, useCallback, useEffect, useMemo } from "react"
import { useTranslation } from "react-i18next"
import { useVirtualizer } from "@tanstack/react-virtual"
import { cn } from "@/lib/utils"
import { toSanitizedMarkdownHtml } from "@/lib/markdown"
import { buildInlineQuestionLayout, parseCommentQuestions, type CommentQuestion } from "@/lib/comment-question-block"
import { LoaderIcon, TerminalIcon, UsersIcon } from "lucide-react"
import { QuickQuestionForm, type QuickQuestionAnswers } from "@/components/quick-question-form"
import { ChatInputBar, type ImageAttachment } from "@/components/chat-input-bar"
import { useLocalStorage } from "usehooks-ts"
import {
  FONT_SIZE_KEY,
  DEFAULT_FONT_SIZE,
  FONT_SIZE_CLASS,
  type FontSizeOption,
} from "@/lib/font-size"
import type { ChatCommandDefinition } from "@/lib/chat-commands"
import type { ConnectionStatus } from "@/hooks/use-gateway"
import type { Message } from "@/hooks/use-session-tabs"

/** Distance (px) from the bottom of the scroll container to consider "near bottom". */
const AUTO_SCROLL_THRESHOLD = 80
/** Number of extra rows to render above/below viewport. */
const VIRTUAL_OVERSCAN_COUNT = 8
/** Bottom padding between virtualized rows. */
const VIRTUAL_ROW_GAP_PX = 20
/** Height estimates for variable-height virtual rows. */
const ESTIMATED_SYSTEM_ROW_HEIGHT_PX = 28
const ESTIMATED_USER_ROW_HEIGHT_PX = 120
const ESTIMATED_TOOL_ROW_HEIGHT_PX = 96
const ESTIMATED_ASSISTANT_ROW_HEIGHT_PX = 180
const ESTIMATED_AWAITING_ROW_HEIGHT_PX = 40
const ESTIMATED_AWAITING_ROW_TOTAL_HEIGHT_PX = ESTIMATED_AWAITING_ROW_HEIGHT_PX + VIRTUAL_ROW_GAP_PX
const AWAITING_ROW_KEY = "__awaiting-response__"
const CHAT_QUESTION_ANSWER_HEADING = "## Question Responses"
const CHAT_QUESTION_ANSWER_BULLET_PREFIX = "   - "
const CHAT_QUESTION_CUSTOM_ANSWER_PREFIX = "Custom: "

type ChatRow =
  | {
      key: string
      kind: "message"
      message: Message
    }
  | {
      key: string
      kind: "awaiting"
    }

function estimateMessageRowHeight(message: Message | undefined): number {
  if (!message) return ESTIMATED_ASSISTANT_ROW_HEIGHT_PX + VIRTUAL_ROW_GAP_PX
  const baseHeight = (() => {
    if (message.role === "system") return ESTIMATED_SYSTEM_ROW_HEIGHT_PX
    if (message.role === "user") return ESTIMATED_USER_ROW_HEIGHT_PX
    if (message.role === "tool") return ESTIMATED_TOOL_ROW_HEIGHT_PX
    return ESTIMATED_ASSISTANT_ROW_HEIGHT_PX
  })()
  return baseHeight + VIRTUAL_ROW_GAP_PX
}

function buildChatRows(messages: Message[], isGenerating: boolean): ChatRow[] {
  const rows: ChatRow[] = messages.map((message) => ({
    key: message.id,
    kind: "message",
    message,
  }))
  if (isGenerating) {
    rows.push({ key: AWAITING_ROW_KEY, kind: "awaiting" })
  }
  return rows
}

function estimateChatRowHeight(row: ChatRow | undefined): number {
  if (!row) return ESTIMATED_ASSISTANT_ROW_HEIGHT_PX + VIRTUAL_ROW_GAP_PX
  if (row.kind === "awaiting") return ESTIMATED_AWAITING_ROW_TOTAL_HEIGHT_PX
  return estimateMessageRowHeight(row.message)
}

function resolveSelectedQuestionLabels(question: CommentQuestion, selectedOptionIds: string[]): string[] {
  const selectedIdSet = new Set(selectedOptionIds)
  return question.options
    .filter((option) => selectedIdSet.has(option.id))
    .map((option) => option.label)
}

function buildChatQuestionAnswerSummary(questions: CommentQuestion[], answers: QuickQuestionAnswers): string {
  const lines: string[] = [CHAT_QUESTION_ANSWER_HEADING, ""]

  questions.forEach((question, index) => {
    const answer = answers[question.id]
    const selectedLabels = resolveSelectedQuestionLabels(question, answer?.selectedOptionIds ?? [])
    const customResponse = answer?.customResponse.trim() ?? ""
    if (selectedLabels.length === 0 && !customResponse) return
    lines.push(`${index + 1}. **${question.title}**`)
    selectedLabels.forEach((label) => {
      lines.push(`${CHAT_QUESTION_ANSWER_BULLET_PREFIX}${label}`)
    })
    if (customResponse) {
      lines.push(`${CHAT_QUESTION_ANSWER_BULLET_PREFIX}${CHAT_QUESTION_CUSTOM_ANSWER_PREFIX}${customResponse}`)
    }
  })

  return lines.join("\n").trim()
}

/* ------------------------------------------------------------------ */
/*  Sub-components                                                     */
/* ------------------------------------------------------------------ */

interface ChatQuestionnaireProps {
  questions: CommentQuestion[]
  disabled: boolean
  onSubmitAnswers: (content: string) => boolean
}

function ChatQuestionnaire({ questions, disabled, onSubmitAnswers }: ChatQuestionnaireProps) {
  return (
    <QuickQuestionForm
      questions={questions}
      disabled={disabled}
      translationPrefix="chat"
      buildStructuredResponse={buildChatQuestionAnswerSummary}
      onSubmitResponse={onSubmitAnswers}
      className="rounded-lg bg-background/80"
      showHeader={false}
    />
  )
}

interface ChatBubbleInnerProps {
  message: Message
  fontSizeClass: string
  canSubmitQuickAnswers: boolean
  onSubmitQuickAnswers: (content: string) => boolean
}

function ChatBubbleInner({
  message,
  fontSizeClass,
  canSubmitQuickAnswers,
  onSubmitQuickAnswers,
}: ChatBubbleInnerProps) {
  const parsed = useMemo(
    () => (message.role === "assistant" ? parseCommentQuestions(message.content) : null),
    [message.role, message.content],
  )
  const inlineLayout = useMemo(
    () => (parsed ? buildInlineQuestionLayout(parsed) : { markdownSegments: [], questions: [] }),
    [parsed],
  )

  const renderedSegments = useMemo(
    () =>
      message.role === "assistant"
      ? inlineLayout.markdownSegments.map((segment, index) => ({
        key: `markdown-${index}`,
        html: toSanitizedMarkdownHtml(segment.content),
      }))
      : [],
    [message.role, inlineLayout.markdownSegments],
  )

  if (message.role === "system") {
    return (
      <div className="flex justify-center">
        <span className="text-xs text-muted-foreground">{message.content}</span>
      </div>
    )
  }

  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-full rounded-2xl bg-muted px-3 py-2.5 sm:px-4 sm:py-3">
          {message.images && message.images.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {message.images.map((src, i) => (
                <img
                  key={i}
                  src={src}
                  alt="attached"
                  className="max-h-40 max-w-40 rounded-lg object-cover sm:max-h-48 sm:max-w-48"
                />
              ))}
            </div>
          )}
          {message.content && (
            <p className={cn("whitespace-pre-wrap break-all leading-normal text-foreground", fontSizeClass)}>
              {message.content}
            </p>
          )}
        </div>
      </div>
    )
  }

  if (message.role === "tool") {
    const isDelegation = message.toolName?.startsWith("delegate:")
    const Icon = isDelegation ? UsersIcon : TerminalIcon
    const colorClass = isDelegation ? "text-chart-4" : "text-chart-3"

    return (
      <div className="flex justify-start">
        <div className="flex flex-col gap-1.5 rounded-xl bg-card ring-1 ring-foreground/10 px-4 py-3">
          <div className="flex items-center gap-1.5">
            <Icon className={cn("size-3", colorClass)} />
            <span className={cn("text-xs font-medium", colorClass)}>
              {message.toolName ?? "tool"}
            </span>
          </div>
          <p className="max-w-lg whitespace-pre-wrap break-words text-xs text-muted-foreground">
            {message.content}
          </p>
        </div>
      </div>
    )
  }

  // Assistant (including streaming)
  return (
    <div className="flex flex-col gap-2">
      {message.images && message.images.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {message.images.map((src, i) => (
            <img
              key={i}
              src={src}
              alt="assistant output"
              className="max-h-72 max-w-full rounded-lg object-cover ring-1 ring-border/70 sm:max-h-80 sm:max-w-80"
            />
          ))}
        </div>
      ) : null}
      {renderedSegments.map((segment) =>
        segment.html
          ? (
            <div
              key={segment.key}
              className={cn("markdown-body min-w-0 break-words leading-normal text-foreground", fontSizeClass)}
              dangerouslySetInnerHTML={{ __html: segment.html }}
            />
            )
          : null,
      )}
      {inlineLayout.questions.length > 0 ? (
        <ChatQuestionnaire
          questions={inlineLayout.questions}
          disabled={!canSubmitQuickAnswers}
          onSubmitAnswers={onSubmitQuickAnswers}
        />
      ) : null}
      {message.streaming ? (
        <div className="h-4 w-0.5 animate-pulse rounded-sm bg-primary" />
      ) : null}
    </div>
  )
}

export const ChatBubble = memo(
  ChatBubbleInner,
  (prev, next) =>
    prev.message === next.message
    && prev.fontSizeClass === next.fontSizeClass
    && prev.canSubmitQuickAnswers === next.canSubmitQuickAnswers
    && prev.onSubmitQuickAnswers === next.onSubmitQuickAnswers,
)
ChatBubble.displayName = "ChatBubble"

function AwaitingResponseRow({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <LoaderIcon className="size-4 animate-spin" />
      <span>{label}</span>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Main Chat (controlled)                                             */
/* ------------------------------------------------------------------ */

interface ChatProps {
  messages: Message[]
  isStreaming: boolean
  isAwaitingResponse: boolean
  status: ConnectionStatus
  slashCommands?: ChatCommandDefinition[]
  onSend: (text: string, images?: ImageAttachment[]) => void
  onCommand: (command: string) => Promise<void>
  onAddAlias?: (alias: string, expansion: string) => Promise<void>
  onStop?: () => void
  onClear?: () => void
}

export function Chat({
  messages,
  isStreaming,
  isAwaitingResponse,
  status,
  slashCommands = [],
  onSend,
  onCommand,
  onAddAlias,
  onStop,
  onClear,
}: ChatProps) {
  const { t } = useTranslation()
  const [input, setInput] = useState("")
  const [images, setImages] = useState<ImageAttachment[]>([])
  const scrollRef = useRef<HTMLDivElement>(null)
  const [fontSize] = useLocalStorage<FontSizeOption>(FONT_SIZE_KEY, DEFAULT_FONT_SIZE)
  const fontSizeClass = FONT_SIZE_CLASS[fontSize] ?? FONT_SIZE_CLASS[DEFAULT_FONT_SIZE]
  const isGenerating = isStreaming || isAwaitingResponse

  const isNearBottom = useRef(true)
  const chatRows = useMemo(
    () => buildChatRows(messages, isGenerating),
    [messages, isGenerating],
  )
  const chatRowCount = chatRows.length
  const assistantThinkingLabel = t("chat.assistantThinking")

  // TanStack Virtual is intentionally used for chat list virtualization.
  // eslint-disable-next-line react-hooks/incompatible-library
  const rowVirtualizer = useVirtualizer({
    count: chatRowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => estimateChatRowHeight(chatRows[index]),
    getItemKey: (index) => chatRows[index]?.key ?? index,
    overscan: VIRTUAL_OVERSCAN_COUNT,
  })
  const virtualItems = rowVirtualizer.getVirtualItems()

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    isNearBottom.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < AUTO_SCROLL_THRESHOLD
  }, [])

  /** Only auto-scroll if the user hasn't scrolled up. */
  useEffect(() => {
    if (!isNearBottom.current) return
    if (chatRowCount === 0) return
    rowVirtualizer.scrollToIndex(chatRowCount - 1, { align: "end" })
  }, [chatRowCount, messages, rowVirtualizer])

  function handleSend(textOverride?: string) {
    const text = (textOverride ?? input).trim()
    const hasContent = text.length > 0 || images.length > 0
    if (!hasContent || status !== "connected") return

    setInput("")
    const attachedImages = images.length > 0 ? [...images] : undefined
    setImages([])

    if (text.startsWith("/")) {
      void onCommand(text)
      return
    }

    onSend(text, attachedImages)
  }

  const connected = status === "connected"
  const canSubmitQuickAnswers = connected && !isGenerating
  const handleSubmitQuickAnswers = useCallback((content: string): boolean => {
    const text = content.trim()
    if (!text || !connected || isGenerating) return false
    onSend(text)
    return true
  }, [connected, isGenerating, onSend])

  return (
    <div data-slot="chat" className="flex min-h-0 flex-1 flex-col">
      {/* Messages */}
      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full min-w-0 max-w-4xl px-3 py-4 sm:px-4 sm:py-5 md:px-8 md:py-6">
          {chatRowCount === 0 ? (
            <p className="pt-20 text-center text-sm text-muted-foreground">
              {t("chat.startMessage")}
            </p>
          ) : (
            <div
              className="relative"
              style={{ height: rowVirtualizer.getTotalSize() }}
            >
              {virtualItems.map((virtualRow) => {
                const row = chatRows[virtualRow.index]
                if (!row) return null

                return (
                  <div
                    key={row.key}
                    data-index={virtualRow.index}
                    ref={rowVirtualizer.measureElement}
                    className="absolute top-0 left-0 w-full"
                    style={{ transform: `translateY(${virtualRow.start}px)` }}
                  >
                    <div style={{ paddingBottom: VIRTUAL_ROW_GAP_PX }}>
                      {row.kind === "awaiting" ? (
                        <AwaitingResponseRow label={assistantThinkingLabel} />
                      ) : (
                        <ChatBubble
                          message={row.message}
                          fontSizeClass={fontSizeClass}
                          canSubmitQuickAnswers={canSubmitQuickAnswers}
                          onSubmitQuickAnswers={handleSubmitQuickAnswers}
                        />
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* Input */}
      <ChatInputBar
        value={input}
        onChange={setInput}
        onSend={handleSend}
        onStop={onStop}
        onClear={onClear}
        connected={connected}
        sending={isGenerating}
        slashCommands={slashCommands}
        onAddAlias={onAddAlias}
        images={images}
        onImagesChange={setImages}
      />
    </div>
  )
}
