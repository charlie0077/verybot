import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { LoaderIcon, PencilIcon, Trash2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { QuickQuestionForm, type QuickQuestionAnswers } from "@/components/quick-question-form"
import { toSanitizedMarkdownHtml } from "@/lib/markdown"
import { buildInlineQuestionLayout, parseCommentQuestions, type CommentQuestion } from "@/lib/comment-question-block"
import type { TaskComment } from "./types"

const EMPTY_COMMENT = ""
const COMMENT_INPUT_ROWS = 3
const QUESTION_ANSWER_HEADING = "## Question Responses"
const QUESTION_ANSWER_REPLY_PREFIX = "> In reply to comment:"
const QUESTION_ANSWER_BULLET_PREFIX = "   - "
const QUESTION_CUSTOM_ANSWER_PREFIX = "Custom: "

interface TaskCommentsPanelProps {
  comments: TaskComment[]
  loading: boolean
  submitting: boolean
  busyCommentId: string | null
  error: string | null
  authorNamesById?: Record<string, string>
  onAdd: (content: string) => Promise<boolean>
  onUpdate: (id: string, content: string) => Promise<boolean>
  onDelete: (id: string) => Promise<void>
}

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString()
}

function resolveAuthorName(authorId: string, authorNamesById?: Record<string, string>): string {
  const mapped = authorNamesById?.[authorId]?.trim()
  return mapped ? mapped : authorId
}

function buildQuestionAnswerSummary(
  commentId: string,
  questions: CommentQuestion[],
  answers: QuickQuestionAnswers,
): string {
  const lines: string[] = [
    QUESTION_ANSWER_HEADING,
    `${QUESTION_ANSWER_REPLY_PREFIX} \`${commentId}\``,
    "",
  ]

  questions.forEach((question, index) => {
    const answer = answers[question.id]
    const selectedLabels = resolveSelectedLabels(question, answer?.selectedOptionIds ?? [])
    const customResponse = answer?.customResponse.trim() ?? ""
    if (selectedLabels.length === 0 && !customResponse) return
    lines.push(`${index + 1}. **${question.title}**`)
    selectedLabels.forEach((label) => {
      lines.push(`${QUESTION_ANSWER_BULLET_PREFIX}${label}`)
    })
    if (customResponse) {
      lines.push(`${QUESTION_ANSWER_BULLET_PREFIX}${QUESTION_CUSTOM_ANSWER_PREFIX}${customResponse}`)
    }
  })

  return lines.join("\n").trim()
}

function resolveSelectedLabels(question: CommentQuestion, selectedOptionIds: string[]): string[] {
  const selectedIdSet = new Set(selectedOptionIds)
  return question.options
    .filter((option) => selectedIdSet.has(option.id))
    .map((option) => option.label)
}

interface CommentQuestionnaireProps {
  commentId: string
  questions: CommentQuestion[]
  disabled: boolean
  onSubmitAnswers: (content: string) => Promise<boolean>
}

function CommentQuestionnaire({ commentId, questions, disabled, onSubmitAnswers }: CommentQuestionnaireProps) {
  return (
    <QuickQuestionForm
      questions={questions}
      disabled={disabled}
      translationPrefix="tasks"
      buildStructuredResponse={(currentQuestions, answers) =>
        buildQuestionAnswerSummary(commentId, currentQuestions, answers)}
      onSubmitResponse={onSubmitAnswers}
      showHeader={false}
    />
  )
}

interface CommentMarkdownProps {
  commentId: string
  content: string
  submitting: boolean
  onAdd: (content: string) => Promise<boolean>
}

function CommentMarkdown({ commentId, content, submitting, onAdd }: CommentMarkdownProps) {
  const parsed = useMemo(() => parseCommentQuestions(content), [content])
  const inlineLayout = useMemo(
    () => buildInlineQuestionLayout(parsed),
    [parsed],
  )
  const renderedSegments = useMemo(
    () =>
      inlineLayout.markdownSegments.map((segment, index) => ({
        key: `markdown-${index}`,
        html: toSanitizedMarkdownHtml(segment.content),
      })),
    [inlineLayout.markdownSegments],
  )

  return (
    <div className="flex flex-col gap-2">
      {renderedSegments.map((segment) =>
        segment.html
          ? (
            <div
              key={segment.key}
              className="markdown-body rounded-md bg-muted/30 px-3 py-2 text-sm text-foreground"
              // Content is sanitized in toSanitizedMarkdownHtml().
              dangerouslySetInnerHTML={{ __html: segment.html }}
            />
            )
          : null,
      )}
      {inlineLayout.questions.length > 0 ? (
        <CommentQuestionnaire
          commentId={commentId}
          questions={inlineLayout.questions}
          disabled={submitting}
          onSubmitAnswers={onAdd}
        />
      ) : null}
    </div>
  )
}

export function TaskCommentsPanel({
  comments,
  loading,
  submitting,
  busyCommentId,
  error,
  authorNamesById,
  onAdd,
  onUpdate,
  onDelete,
}: TaskCommentsPanelProps) {
  const { t } = useTranslation()
  const [newComment, setNewComment] = useState(EMPTY_COMMENT)
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null)
  const [editingContent, setEditingContent] = useState(EMPTY_COMMENT)

  const canSubmitComment = useMemo(
    () => newComment.trim().length > 0 && !submitting,
    [newComment, submitting],
  )

  async function handleAddComment() {
    const content = newComment.trim()
    if (!content || submitting) return
    const saved = await onAdd(content)
    if (saved) {
      setNewComment(EMPTY_COMMENT)
    }
  }

  function handleStartEdit(comment: TaskComment) {
    setEditingCommentId(comment.id)
    setEditingContent(comment.content)
  }

  function handleCancelEdit() {
    setEditingCommentId(null)
    setEditingContent(EMPTY_COMMENT)
  }

  async function handleSaveEdit(commentId: string) {
    const content = editingContent.trim()
    if (!content || busyCommentId === commentId) return
    const saved = await onUpdate(commentId, content)
    if (saved) {
      handleCancelEdit()
    }
  }

  return (
    <section data-slot="task-comments-panel" className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold text-foreground">{t("tasks.comments")}</h2>

      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : null}

      {loading ? (
        <div className="flex items-center justify-center py-6 text-muted-foreground">
          <LoaderIcon className="size-4 animate-spin" />
        </div>
      ) : comments.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("tasks.noComments")}</p>
      ) : (
        <div className="flex flex-col gap-3">
          {comments.map((comment) => {
            const isEditing = editingCommentId === comment.id
            const isBusy = busyCommentId === comment.id
            const edited = comment.updatedAt > comment.createdAt
            return (
              <article key={comment.id} className="rounded-lg border border-border/70 bg-card/50 p-3">
                <div className="mb-2 flex items-start justify-between gap-2">
                  <p className="text-xs leading-5 text-muted-foreground">
                    <span className="font-medium text-foreground">
                      {resolveAuthorName(comment.createdBy, authorNamesById)}
                    </span>
                    {" · "}
                    <span>{formatTimestamp(comment.createdAt)}</span>
                    {edited ? (
                      <>
                        {" · "}
                        <span>{t("tasks.edited")}</span>
                      </>
                    ) : null}
                  </p>
                  <div className="flex items-center gap-1">
                    {isEditing ? null : (
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={t("tasks.editComment")}
                        onClick={() => handleStartEdit(comment)}
                        disabled={isBusy}
                      >
                        <PencilIcon className="size-3.5" />
                      </Button>
                    )}
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={t("tasks.deleteCommentAction")}
                      onClick={() => void onDelete(comment.id)}
                      disabled={isBusy}
                    >
                      {isBusy ? <LoaderIcon className="size-3.5 animate-spin" /> : <Trash2Icon className="size-3.5" />}
                    </Button>
                  </div>
                </div>

                {isEditing ? (
                  <div className="flex flex-col gap-2 rounded-md border border-border bg-card p-3">
                    <Textarea
                      value={editingContent}
                      rows={COMMENT_INPUT_ROWS}
                      onChange={(event) => setEditingContent(event.target.value)}
                    />
                    <div className="flex items-center justify-end gap-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={handleCancelEdit}
                        disabled={isBusy}
                      >
                        {t("tasks.cancelEditComment")}
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => void handleSaveEdit(comment.id)}
                        disabled={!editingContent.trim() || isBusy}
                      >
                        {isBusy ? <LoaderIcon className="mr-1.5 size-3.5 animate-spin" /> : null}
                        {t("tasks.saveComment")}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <CommentMarkdown
                    commentId={comment.id}
                    content={comment.content}
                    submitting={submitting}
                    onAdd={onAdd}
                  />
                )}
              </article>
            )
          })}
        </div>
      )}

      <div className="flex flex-col gap-2 rounded-lg border border-border bg-card/60 p-2.5">
        <Textarea
          value={newComment}
          onChange={(event) => setNewComment(event.target.value)}
          placeholder={t("tasks.commentPlaceholder")}
          rows={COMMENT_INPUT_ROWS}
          className="min-h-20 border-0 bg-transparent px-1 py-1 shadow-none focus-visible:ring-0"
        />
        <div className="flex items-center justify-end">
          <Button size="sm" onClick={() => void handleAddComment()} disabled={!canSubmitComment} className="h-8 px-3.5">
            {submitting ? <LoaderIcon className="mr-1.5 size-3.5 animate-spin" /> : null}
            {t("tasks.addComment")}
          </Button>
        </div>
      </div>
    </section>
  )
}
