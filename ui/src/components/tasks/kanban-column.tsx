import { useState, useMemo } from "react"
import { useTranslation } from "react-i18next"
import { useDroppable } from "@dnd-kit/core"
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable"
import {
  PlusIcon,
  ArchiveIcon,
  ChevronDownIcon,
  ChevronUpIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { SortableTaskCard } from "./task-card"
import { DONE_VISIBLE_LIMIT, type Task, type TaskStatus } from "./types"

/* ------------------------------------------------------------------ */
/*  Kanban Column (droppable + sortable)                               */
/* ------------------------------------------------------------------ */

const MOBILE_COLUMN_WIDTH_CLASS = "h-full basis-50 min-w-50 max-w-72 snap-start shrink-0"
const DESKTOP_COLUMN_WIDTH_CLASS = "h-full basis-50 min-w-50 max-w-72 flex-1"

export interface KanbanColumnProps {
  statusKey: TaskStatus
  label: string
  color: string
  tasks: Task[]
  teamNamesById?: Record<string, string>
  agentNamesById?: Record<string, string>
  getSubscribedWorkerIds?: (task: Task) => string[]
  getLatestSessionKey?: (task: Task) => string | undefined
  isOver: boolean
  onDelete: (id: string) => void
  onEdit: (task: Task) => void
  onWorkOn?: (task: Task) => void
  onOpenLatestSession?: (task: Task) => void
  onAdd: () => void
  onClearDone?: () => void
  compact?: boolean
}

export function KanbanColumn({
  statusKey,
  label,
  color,
  tasks,
  teamNamesById,
  agentNamesById,
  getSubscribedWorkerIds,
  getLatestSessionKey,
  isOver,
  onDelete,
  onEdit,
  onWorkOn,
  onOpenLatestSession,
  onAdd,
  onClearDone,
  compact = false,
}: KanbanColumnProps) {
  const { t } = useTranslation()
  const [showAll, setShowAll] = useState(false)
  const { setNodeRef, isOver: isDroppableOver } = useDroppable({
    id: statusKey,
    data: { status: statusKey },
  })

  const highlighted = isOver || isDroppableOver
  const isDone = typeof onClearDone === "function"
  const visibleTasks = isDone && !showAll ? tasks.slice(0, DONE_VISIBLE_LIMIT) : tasks
  const hasMore = isDone && tasks.length > DONE_VISIBLE_LIMIT
  const taskIds = useMemo(() => visibleTasks.map((t) => t.id), [visibleTasks])

  return (
    <div
      ref={setNodeRef}
      data-column={statusKey}
      className={cn(
        "flex min-h-0 min-w-0 flex-col gap-3 rounded-xl border-2 border-dashed px-1 pt-3 pb-0 transition-colors",
        compact ? MOBILE_COLUMN_WIDTH_CLASS : DESKTOP_COLUMN_WIDTH_CLASS,
        highlighted ? "border-primary/50 bg-primary/5" : "border-transparent",
      )}
    >
      {/* Column header */}
      <div className="flex flex-col gap-1">
        <div className="flex h-7 items-center justify-between">
          <div className="flex items-center gap-2">
            <span
              className="size-3 rounded-full shrink-0"
              style={{ backgroundColor: color }}
            />
            <span className="text-sm font-semibold text-foreground">{label}</span>
            <span className="text-xs text-muted-foreground">({tasks.length})</span>
          </div>
          {isDone && tasks.length > 0 && onClearDone && (
            <Button size="sm" variant="ghost" onClick={onClearDone} className="h-7 text-xs">
              <ArchiveIcon className="mr-1 size-3" />
              {t("common.clear")}
            </Button>
          )}
        </div>
      </div>

      {/* Sortable cards */}
      <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
        <div
          className={cn(
            "flex min-h-0 flex-col pr-1",
            "flex-1 overflow-y-auto pb-1",
          )}
        >
          <div className="flex flex-col gap-2">
            {visibleTasks.map((task) => (
              <SortableTaskCard
                key={task.id}
                task={task}
                teamName={teamNamesById?.[task.teamId]}
                agentNamesById={agentNamesById}
                subscribedWorkerIds={getSubscribedWorkerIds?.(task) ?? []}
                latestSessionKey={getLatestSessionKey?.(task)}
                onDelete={() => onDelete(task.id)}
                onEdit={() => onEdit(task)}
                onWorkOn={onWorkOn ? () => onWorkOn(task) : undefined}
                onOpenLatestSession={onOpenLatestSession ? () => onOpenLatestSession(task) : undefined}
              />
            ))}

            {tasks.length === 0 && (
              <p className="py-8 text-center text-xs text-muted-foreground">
                {highlighted ? t("tasks.dropHere") : t("tasks.noTasks")}
              </p>
            )}

            {hasMore && (
              <button
                onClick={() => setShowAll((prev) => !prev)}
                className="flex items-center justify-center gap-1 rounded-md border border-border py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                {showAll ? (
                  <><ChevronUpIcon className="size-3" /> {t("tasks.showLess")}</>
                ) : (
                  <><ChevronDownIcon className="size-3" /> {t("tasks.showAll", { count: tasks.length })}</>
                )}
              </button>
            )}
          </div>

          <button
            onClick={onAdd}
            className="mt-1 flex items-center justify-center gap-1 rounded-lg border border-dashed border-border py-2 text-xs text-muted-foreground hover:border-foreground/30 hover:text-foreground transition-colors"
          >
            <PlusIcon className="size-3.5" />
            {t("tasks.addTaskInline")}
          </button>
        </div>
      </SortableContext>
    </div>
  )
}
