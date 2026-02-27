import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { LoaderIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import type { CommentQuestion } from "@/lib/comment-question-block"

const QUICK_QUESTION_MANUAL_INPUT_ROWS = 3
const QUICK_QUESTION_CUSTOM_INPUT_ROWS = 1

type TranslationPrefix = "chat" | "tasks"

export interface QuickQuestionAnswer {
  selectedOptionIds: string[]
  customResponse: string
}

export type QuickQuestionAnswers = Record<string, QuickQuestionAnswer>

interface QuickQuestionFormProps {
  questions: CommentQuestion[]
  disabled: boolean
  translationPrefix: TranslationPrefix
  buildStructuredResponse: (questions: CommentQuestion[], answers: QuickQuestionAnswers) => string
  onSubmitResponse: (content: string) => boolean | Promise<boolean>
  className?: string
  showHeader?: boolean
}

function hasAnswersForAllQuestions(questions: CommentQuestion[], answers: QuickQuestionAnswers): boolean {
  return questions.every((question) => hasAnyAnswer(answers[question.id]))
}

function hasAnyStructuredAnswer(answers: QuickQuestionAnswers): boolean {
  return Object.values(answers).some((answer) => hasAnyAnswer(answer))
}

function hasAnyAnswer(answer: QuickQuestionAnswer | undefined): boolean {
  if (!answer) return false
  return answer.selectedOptionIds.length > 0 || answer.customResponse.trim().length > 0
}

function buildAdditionalNote(note: string, label: string): string {
  const trimmed = note.trim()
  if (!trimmed) return ""
  if (trimmed.includes("\n")) {
    return `${label}:\n${trimmed}`
  }
  const escaped = trimmed.replaceAll('"', '\\"')
  return `${label}: "${escaped}"`
}

function normalizeTextForComparison(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ")
}

export function QuickQuestionForm({
  questions,
  disabled,
  translationPrefix,
  buildStructuredResponse,
  onSubmitResponse,
  className,
  showHeader = true,
}: QuickQuestionFormProps) {
  const { t } = useTranslation()
  const [answers, setAnswers] = useState<QuickQuestionAnswers>({})
  const [manualResponse, setManualResponse] = useState("")
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const canSubmit = useMemo(
    () =>
      (manualResponse.trim().length > 0 || hasAnswersForAllQuestions(questions, answers))
      && !disabled
      && !submitting,
    [manualResponse, questions, answers, disabled, submitting],
  )

  function handleSelectOption(question: CommentQuestion, optionId: string) {
    setSubmitted(false)
    setSubmitError(null)
    setAnswers((prev) => {
      const current = prev[question.id] ?? { selectedOptionIds: [], customResponse: "" }
      if (question.type === "single") {
        const selectedOptionIds = current.selectedOptionIds.includes(optionId) ? [] : [optionId]
        return {
          ...prev,
          [question.id]: {
            ...current,
            selectedOptionIds,
          },
        }
      }
      const selected = current.selectedOptionIds.includes(optionId)
      const next = selected
        ? current.selectedOptionIds.filter((id) => id !== optionId)
        : [...current.selectedOptionIds, optionId]
      return {
        ...prev,
        [question.id]: {
          ...current,
          selectedOptionIds: next,
        },
      }
    })
  }

  function handleChangeQuestionCustomResponse(questionId: string, nextValue: string) {
    setSubmitted(false)
    setSubmitError(null)
    setAnswers((prev) => {
      const current = prev[questionId] ?? { selectedOptionIds: [], customResponse: "" }
      return {
        ...prev,
        [questionId]: {
          ...current,
          customResponse: nextValue,
        },
      }
    })
  }

  async function handleSubmitResponse() {
    if (!canSubmit) return
    setSubmitting(true)
    setSubmitError(null)

    const manualContent = manualResponse.trim()
    const includeStructuredResponse = hasAnyStructuredAnswer(answers)
    const structuredContent = includeStructuredResponse ? buildStructuredResponse(questions, answers) : ""
    const manualSummary = includeStructuredResponse
      ? buildAdditionalNote(manualContent, t(`${translationPrefix}.questionAdditionalNoteLabel`))
      : manualContent
    const content = [structuredContent, manualSummary].filter((part) => part.length > 0).join("\n\n").trim()
    const sent = await Promise.resolve(onSubmitResponse(content))

    if (sent) {
      setSubmitted(true)
      setManualResponse("")
      setAnswers({})
    } else {
      setSubmitError(t(`${translationPrefix}.questionResponseSubmitFailed`))
    }
    setSubmitting(false)
  }

  return (
    <div className={cn("flex flex-col gap-2 rounded-md border border-border bg-background/70 p-3", className)}>
      {showHeader ? (
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t(`${translationPrefix}.quickQuestions`)}
        </p>
      ) : null}

      {questions.map((question, index) => {
        const selectedOptionIds = answers[question.id]?.selectedOptionIds ?? []
        const customResponse = answers[question.id]?.customResponse ?? ""
        const showQuestionTitle = normalizeTextForComparison(question.contextTitle ?? "")
          !== normalizeTextForComparison(question.title)
        const questionText = showQuestionTitle ? question.title : (question.contextTitle ?? question.title)
        const hasContextTitle = Boolean(question.contextTitle && showQuestionTitle)
        return (
          <div key={question.id} className="rounded-md bg-muted/50 p-2.5">
            {hasContextTitle ? (
              <p className="text-sm font-semibold text-foreground">
                {index + 1}. {question.contextTitle}
              </p>
            ) : null}
            {question.contextBody ? (
              <p className="mt-1 whitespace-pre-wrap text-sm text-foreground">
                {question.contextBody}
              </p>
            ) : null}
            <p
              className={cn(
                "flex items-start gap-2 text-base font-semibold text-foreground",
                hasContextTitle || question.contextBody ? "mt-2" : ""
              )}
            >
              <span className="mt-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-foreground/10 px-1.5 text-xs font-semibold text-foreground">
                Q{index + 1}
              </span>
              <span className="flex-1">{questionText}</span>
            </p>
            <p className="mb-2 text-xs text-muted-foreground">
              {question.type === "single"
                ? t(`${translationPrefix}.questionSelectOne`)
                : t(`${translationPrefix}.questionSelectMany`)}
            </p>
            <div className="flex flex-wrap gap-2">
              {question.options.map((option) => {
                const isSelected = selectedOptionIds.includes(option.id)
                return (
                  <Button
                    key={option.id}
                    type="button"
                    size="sm"
                    variant={isSelected ? "default" : "outline"}
                    onClick={() => handleSelectOption(question, option.id)}
                    disabled={disabled || submitting}
                    className={cn("min-h-10 max-w-full whitespace-normal px-3.5 py-1.5 text-left leading-snug")}
                  >
                    {option.label}
                  </Button>
                )
              })}
            </div>
            <div className="mt-2">
              <p className="mb-1 text-xs text-muted-foreground">
                {t(`${translationPrefix}.questionCustomInputLabel`)}
              </p>
              <Textarea
                value={customResponse}
                onChange={(event) => handleChangeQuestionCustomResponse(question.id, event.target.value)}
                rows={QUICK_QUESTION_CUSTOM_INPUT_ROWS}
                className="min-h-10 py-2"
                placeholder={t(`${translationPrefix}.questionCustomInputPlaceholder`)}
                disabled={disabled || submitting}
              />
            </div>
          </div>
        )
      })}

      <div className="rounded-md bg-muted/50 p-2.5">
        <p className="mb-2 text-sm font-medium text-foreground">
          {t(`${translationPrefix}.questionManualInputLabel`)}
        </p>
        <Textarea
          value={manualResponse}
          onChange={(event) => {
            setSubmitted(false)
            setSubmitError(null)
            setManualResponse(event.target.value)
          }}
          rows={QUICK_QUESTION_MANUAL_INPUT_ROWS}
          placeholder={t(`${translationPrefix}.questionManualInputPlaceholder`)}
          disabled={disabled || submitting}
        />
      </div>

      {submitError ? (
        <p className="text-xs text-destructive">{submitError}</p>
      ) : null}
      {submitted ? (
        <p className="text-xs text-emerald-600 dark:text-emerald-400">
          {t(`${translationPrefix}.questionResponseSubmitted`)}
        </p>
      ) : null}

      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          onClick={() => void handleSubmitResponse()}
          disabled={!canSubmit}
        >
          {submitting ? <LoaderIcon className="mr-1.5 size-3.5 animate-spin" /> : null}
          {t(`${translationPrefix}.submitQuestionResponse`)}
        </Button>
      </div>
    </div>
  )
}
