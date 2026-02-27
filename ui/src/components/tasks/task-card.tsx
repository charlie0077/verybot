import { useEffect, useRef } from "react"
import { useTranslation } from "react-i18next"
import { useSortable } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { LoaderIcon, PlayIcon, ScrollTextIcon, Trash2Icon, UserIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { PRIORITY_ICONS, type Task } from "./types"
import { formatTaskLabel } from "./task-label"

/* ------------------------------------------------------------------ */
/*  Sortable Task Card                                                 */
/* ------------------------------------------------------------------ */

interface TaskCardProps {
  task: Task
  teamName?: string
  agentNamesById?: Record<string, string>
  subscribedWorkerIds?: string[]
  latestSessionKey?: string
  onDelete: () => void
  onEdit: () => void
  onWorkOn?: () => void
  onOpenLatestSession?: () => void
}

const WORKER_SPINNER_DURATION_MS = 1800 as const
const HUMAN_REVIEW_ICON_PULSE_DURATION_MS = 1900 as const
const HUMAN_REVIEW_OUTLINE_PING_DURATION_MS = 2200 as const
const WORKER_NAME_MAX_WIDTH_CLASS = "max-w-32"

function priorityLabelKey(priority: Task["priority"]): "tasks.priorityHigh" | "tasks.priorityMedium" | "tasks.priorityLow" {
  switch (priority) {
    case "high":
      return "tasks.priorityHigh"
    case "low":
      return "tasks.priorityLow"
    default:
      return "tasks.priorityMedium"
  }
}

function TaskPriorityIndicator({ priority }: { priority: Task["priority"] }) {
  const { t } = useTranslation()
  const priorityConfig = PRIORITY_ICONS[priority]
  const PriorityIcon = priorityConfig.icon
  const priorityLabel = t(priorityLabelKey(priority))

  return (
    <span
      title={priorityLabel}
      aria-label={priorityLabel}
      className="inline-flex size-5 items-center justify-center rounded-md bg-muted/40"
    >
      <PriorityIcon aria-hidden className={cn("size-3.5", priorityConfig.color)} />
    </span>
  )
}

export function SortableTaskCard({
  task,
  teamName,
  agentNamesById,
  latestSessionKey,
  onDelete,
  onEdit,
  onWorkOn,
  onOpenLatestSession,
}: TaskCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id, data: { status: task.status } })
  const { t } = useTranslation()

  /* Track whether a drag occurred so onClick doesn't fire after drop */
  const didDragRef = useRef(false)
  useEffect(() => { if (isDragging) didDragRef.current = true }, [isDragging])

  function handleClick() {
    if (didDragRef.current) { didDragRef.current = false; return }
    onEdit()
  }

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  }
  const taskLabel = formatTaskLabel(task, teamName)
  const hasRelatedSession = Boolean(latestSessionKey)
  const canRunTask = Boolean(onWorkOn && !hasRelatedSession)
  const canOpenLatestSession = Boolean(onOpenLatestSession && hasRelatedSession)

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "group flex cursor-grab touch-pan-y flex-col gap-2 rounded-lg border border-border bg-card p-3 shadow-sm transition-shadow hover:shadow-md active:cursor-grabbing",
        isDragging && "opacity-30",
      )}
      onClick={handleClick}
      {...attributes}
      {...listeners}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-[11px] font-medium tracking-wide text-muted-foreground">
          {taskLabel}
        </span>
        <div className="flex shrink-0 gap-0.5 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100">
          {canRunTask && (
            <Button
              size="icon"
              variant="ghost"
              aria-label="Run task"
              onClick={(e) => { e.stopPropagation(); onWorkOn?.() }}
              onPointerDown={(e) => e.stopPropagation()}
              className="size-6"
            >
              <PlayIcon className="size-3 text-muted-foreground hover:text-primary" />
            </Button>
          )}
          {canOpenLatestSession && (
            <Button
              size="icon"
              variant="ghost"
              aria-label={t("tasks.openLatestRunningSession")}
              onClick={(e) => { e.stopPropagation(); onOpenLatestSession?.() }}
              onPointerDown={(e) => e.stopPropagation()}
              className="size-6"
            >
              <ScrollTextIcon className="size-3 text-muted-foreground hover:text-foreground" />
            </Button>
          )}
          <Button
            size="icon"
            variant="ghost"
            onClick={(e) => { e.stopPropagation(); onDelete() }}
            onPointerDown={(e) => e.stopPropagation()}
            className="size-6"
          >
            <Trash2Icon className="size-3 text-muted-foreground hover:text-destructive" />
          </Button>
        </div>
      </div>

      <p className="text-sm font-medium leading-snug text-card-foreground line-clamp-2 break-words">
        {task.title}
      </p>

      <div className="flex items-center gap-2">
        <TaskPriorityIndicator priority={task.priority} />
        {task.needsHumanReview && <HumanReviewBadge />}
        {task.claimedBy && <WorkingBadge workerName={agentNamesById?.[task.claimedBy] ?? task.claimedBy} />}
      </div>
    </div>
  )
}

function HumanReviewBadge() {
  const { t } = useTranslation()
  const humanReviewLabel = t("tasks.needsHumanReview")
  return (
    <span
      title={humanReviewLabel}
      aria-label={humanReviewLabel}
      className="relative inline-flex size-5 items-center justify-center rounded-md border border-border/80 bg-muted/40 text-primary"
    >
      <span
        aria-hidden
        className="absolute inset-0.5 rounded-md border border-primary/40 animate-ping"
        style={{ animationDuration: `${HUMAN_REVIEW_OUTLINE_PING_DURATION_MS}ms` }}
      />
      <UserIcon
        aria-hidden
        className="relative z-10 size-3 animate-pulse"
        style={{ animationDuration: `${HUMAN_REVIEW_ICON_PULSE_DURATION_MS}ms` }}
      />
      <span className="sr-only">{humanReviewLabel}</span>
    </span>
  )
}

function WorkingBadge({ workerName }: { workerName: string }) {
  return (
    <span
      title={workerName}
      className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-md bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary"
    >
      <LoaderIcon
        className="size-3.5 shrink-0 animate-spin"
        style={{ animationDuration: `${WORKER_SPINNER_DURATION_MS}ms` }}
        aria-hidden
      />
      <span className={cn(WORKER_NAME_MAX_WIDTH_CLASS, "truncate")}>{workerName}</span>
    </span>
  )
}

/** Static card shown in the drag overlay (no sortable hooks). */
export function TaskCardOverlay({ task, teamName, agentNamesById }: { task: Task; teamName?: string; agentNamesById?: Record<string, string> }) {
  const taskLabel = formatTaskLabel(task, teamName)
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-primary/50 bg-card p-3 shadow-lg ring-2 ring-primary/20">
      <span className="text-[11px] font-medium tracking-wide text-muted-foreground">
        {taskLabel}
      </span>
      <p className="text-sm font-medium leading-snug text-card-foreground line-clamp-2 break-words">
        {task.title}
      </p>
      <div className="flex items-center gap-2">
        <TaskPriorityIndicator priority={task.priority} />
        {task.needsHumanReview && <HumanReviewBadge />}
        {task.claimedBy && <WorkingBadge workerName={agentNamesById?.[task.claimedBy] ?? task.claimedBy} />}
      </div>
    </div>
  )
}
