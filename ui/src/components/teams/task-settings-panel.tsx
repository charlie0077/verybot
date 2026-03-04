import { useTranslation } from "react-i18next"
import {
  DndContext,
  closestCenter,
  useSensor,
  useSensors,
  PointerSensor,
  type DragEndEvent,
} from "@dnd-kit/core"
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import {
  ListChecksIcon,
  PlusIcon,
  GripVerticalIcon,
  Trash2Icon,
  CheckIcon,
  ChevronDownIcon,
  UsersIcon,
} from "lucide-react"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { DEFAULT_TASK_STATUSES, type TaskStatusConfig } from "../tasks/types"
import type { TeamConfig } from "./types"

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const DRAG_ACTIVATION_DISTANCE = 5
const PRESET_COLOR_GRID_CLASS = "grid-cols-8"

const PRESET_COLORS = [
  "#64748b", // slate
  "#71717a", // zinc
  "#ef4444", // red
  "#b91c1c", // red-700
  "#f43f5e", // rose
  "#be123c", // rose-700
  "#f97316", // orange
  "#c2410c", // orange-700
  "#f59e0b", // amber
  "#ca8a04", // yellow-600
  "#84cc16", // lime
  "#65a30d", // lime-600
  "#22c55e", // green
  "#10b981", // emerald
  "#059669", // emerald-600
  "#14b8a6", // teal
  "#0d9488", // teal-600
  "#06b6d4", // cyan
  "#0284c7", // sky-600
  "#0ea5e9", // sky
  "#3b82f6", // blue
  "#2563eb", // blue-600
  "#6366f1", // indigo
  "#7c3aed", // violet-600
  "#8b5cf6", // violet
  "#a855f7", // purple
  "#d946ef", // fuchsia
  "#ec4899", // pink
  "#db2777", // pink-600
  "#a16207", // amber-700
  "#15803d", // green-700
  "#4d7c0f", // lime-700
] as const

/** Slugify a label into a valid status key. */
function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
}

/* ------------------------------------------------------------------ */
/*  Sortable status row                                                */
/* ------------------------------------------------------------------ */

interface SortableStatusRowProps {
  status: TaskStatusConfig
  allStatuses: TaskStatusConfig[]
  onUpdate: (updates: Partial<TaskStatusConfig>) => void
  onDelete: () => void
  isDuplicateKey: boolean
}

function SortableStatusRow({ status, allStatuses, onUpdate, onDelete, isDuplicateKey }: SortableStatusRowProps) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const consensusMode = status.consensus ?? "none"
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: status.key })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }

  // Other statuses for transition dropdowns (exclude self and other unanimous statuses)
  const otherStatuses = allStatuses.filter((s) => s.key !== status.key && s.consensus !== 'unanimous')

  return (
    <div ref={setNodeRef} style={style} className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="cursor-grab touch-none text-muted-foreground hover:text-foreground"
          {...attributes}
          {...listeners}
        >
          <GripVerticalIcon className="size-3.5" />
        </button>

        {/* Color picker */}
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="size-6 shrink-0 rounded-full border border-border transition-colors hover:ring-2 hover:ring-border"
              style={{ backgroundColor: status.color }}
              aria-label={t("teams.statusColor")}
            />
          </PopoverTrigger>
          <PopoverContent className="w-auto p-2" align="start">
            <div className={cn("grid gap-1.5", PRESET_COLOR_GRID_CLASS)}>
              {PRESET_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => onUpdate({ color: c })}
                  className={cn(
                    "size-6 rounded-full border-2 transition-all",
                    status.color === c
                      ? "border-foreground scale-110"
                      : "border-transparent hover:scale-110",
                  )}
                  style={{ backgroundColor: c }}
                >
                  {status.color === c && (
                    <CheckIcon className="size-3 mx-auto text-white drop-shadow-sm" />
                  )}
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>

        {/* Label */}
        <Input
          value={status.label}
          onChange={(e) => onUpdate({ label: e.target.value })}
          className="h-7 flex-1 text-xs"
          placeholder={t("teams.statusLabel")}
        />

        {/* Consensus indicator + expand toggle */}
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className={cn(
            "flex items-center gap-1 shrink-0 rounded px-1.5 py-0.5 text-[10px] transition-colors",
            consensusMode === "unanimous"
              ? "bg-chart-1/10 text-chart-1 hover:bg-chart-1/20"
              : "text-muted-foreground hover:text-foreground hover:bg-muted",
          )}
          title={t("teams.consensus")}
        >
          <UsersIcon className="size-3" />
          <ChevronDownIcon className={cn("size-3 transition-transform", expanded && "rotate-180")} />
        </button>

        {/* Delete */}
        <Button
          size="icon"
          variant="ghost"
          className="size-7 shrink-0"
          onClick={onDelete}
        >
          <Trash2Icon className="size-3 text-muted-foreground" />
        </Button>

        {isDuplicateKey && (
          <span className="text-[10px] text-destructive whitespace-nowrap">{t("teams.duplicateStatusKey")}</span>
        )}
      </div>

      {/* Consensus settings (expandable) */}
      {expanded && (
        <div className="ml-8 flex flex-col gap-2 rounded-md border border-border/50 bg-muted/30 p-2.5">
          <div className="flex items-center gap-2">
            <Label className="text-[11px] text-muted-foreground w-24 shrink-0">{t("teams.consensus")}</Label>
            <Select
              value={consensusMode}
              onValueChange={(value: "none" | "unanimous") => {
                if (value === "none") {
                  onUpdate({ consensus: "none", disagreementTransition: undefined })
                } else {
                  onUpdate({ consensus: value })
                }
              }}
            >
              <SelectTrigger className="h-7 text-xs flex-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{t("teams.consensusNone")}</SelectItem>
                <SelectItem value="unanimous">{t("teams.consensusUnanimous")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {consensusMode === "unanimous" && (
            <>
              <p className="text-[10px] text-muted-foreground">{t("teams.consensusHelp")}</p>
              <div className="flex items-center gap-2">
                <Label className="text-[11px] text-muted-foreground w-24 shrink-0">{t("teams.disagreementTransition")}</Label>
                <Select
                  value={status.disagreementTransition ?? undefined}
                  onValueChange={(value) => onUpdate({ disagreementTransition: value })}
                >
                  <SelectTrigger className="h-7 text-xs flex-1">
                    <SelectValue placeholder={t("teams.selectStatus")} />
                  </SelectTrigger>
                  <SelectContent>
                    {otherStatuses.map((s) => (
                      <SelectItem key={s.key} value={s.key}>{s.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Subscription matrix                                                */
/* ------------------------------------------------------------------ */

interface SubscriptionMatrixProps {
  statuses: TaskStatusConfig[]
  workers: TeamConfig["workers"]
  onToggle: (workerIndex: number, statusKey: string, enabled: boolean) => void
}

function SubscriptionMatrix({ statuses, workers, onToggle }: SubscriptionMatrixProps) {
  const { t } = useTranslation()

  if (workers.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">{t("teams.noWorkersMessage")}</p>
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border">
            <th className="pb-2 pr-3 text-left font-medium text-muted-foreground">{t("tasks.status")}</th>
            {workers.map((w, i) => (
              <th key={w._key ?? i} className="pb-2 px-2 text-center font-medium text-muted-foreground whitespace-nowrap">
                {w.name || t("teams.worker", { index: i + 1 })}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {statuses.map((s) => (
            <tr key={s.key} className="border-b border-border/50">
              <td className="py-2 pr-3">
                <div className="flex items-center gap-2">
                  <span
                    className="size-2.5 rounded-full shrink-0"
                    style={{ backgroundColor: s.color }}
                  />
                  <span className="text-foreground">{s.label}</span>
                </div>
              </td>
              {workers.map((w, i) => {
                const checked = w.subscriptions?.includes(s.key) ?? false
                const workerLabel = w.name || t("teams.worker", { index: i + 1 })
                return (
                  <td key={w._key ?? i} className="py-2 px-2 text-center">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => onToggle(i, s.key, e.target.checked)}
                      className="size-3.5 cursor-pointer accent-primary"
                      aria-label={`${workerLabel} — ${s.label}`}
                    />
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Main panel                                                         */
/* ------------------------------------------------------------------ */

interface TaskSettingsPanelProps {
  draft: TeamConfig
  onDraftChange: React.Dispatch<React.SetStateAction<TeamConfig>>
}

export function TaskSettingsPanel({ draft, onDraftChange }: TaskSettingsPanelProps) {
  const { t } = useTranslation()

  const statuses = draft.statuses ?? [...DEFAULT_TASK_STATUSES]

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: DRAG_ACTIVATION_DISTANCE } }),
  )

  function setStatuses(next: TaskStatusConfig[]) {
    onDraftChange((prev) => ({ ...prev, statuses: next }))
  }

  function handleAddStatus() {
    const label = "New Status"
    let key = slugify(label)
    // Ensure unique key
    let suffix = 1
    const existingKeys = new Set(statuses.map((s) => s.key))
    while (existingKeys.has(key)) {
      key = `${slugify(label)}_${suffix++}`
    }
    setStatuses([...statuses, { key, label, color: "#64748b" }])
  }

  function handleUpdateStatus(index: number, updates: Partial<TaskStatusConfig>) {
    const next = statuses.map((s, i) => (i === index ? { ...s, ...updates } : s))
    setStatuses(next)
  }

  function handleDeleteStatus(index: number) {
    setStatuses(statuses.filter((_, i) => i !== index))
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = statuses.findIndex((s) => s.key === active.id)
    const newIndex = statuses.findIndex((s) => s.key === over.id)
    if (oldIndex === -1 || newIndex === -1) return
    setStatuses(arrayMove(statuses, oldIndex, newIndex))
  }

  function handleToggleSubscription(workerIndex: number, statusKey: string, enabled: boolean) {
    onDraftChange((prev) => {
      const workers = prev.workers.map((worker, index) => {
        if (index !== workerIndex) return worker
        const subscriptions = (worker.subscriptions ?? []).filter((s) => s !== statusKey)
        if (enabled) {
          return { ...worker, subscriptions: [...subscriptions, statusKey] }
        }
        return { ...worker, subscriptions }
      })
      return { ...prev, workers }
    })
  }

  // Detect duplicate keys
  const keyCount = new Map<string, number>()
  for (const s of statuses) {
    keyCount.set(s.key, (keyCount.get(s.key) ?? 0) + 1)
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-2">
        <ListChecksIcon className="size-4 text-chart-1" />
        <h2 className="text-base font-semibold text-foreground">{t("teams.taskSettings")}</h2>
      </div>

      {/* Status list */}
      <div className="flex flex-col gap-3">
        <Label className="text-xs font-medium text-foreground">{t("teams.taskStatuses")}</Label>

        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={statuses.map((s) => s.key)}
            strategy={verticalListSortingStrategy}
          >
            <div className="flex flex-col gap-2">
              {statuses.map((status, index) => (
                <SortableStatusRow
                  key={status.key}
                  status={status}
                  allStatuses={statuses}
                  onUpdate={(updates) => handleUpdateStatus(index, updates)}
                  onDelete={() => handleDeleteStatus(index)}
                  isDuplicateKey={(keyCount.get(status.key) ?? 0) > 1}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>

        <Button size="sm" variant="outline" onClick={handleAddStatus} className="w-fit">
          <PlusIcon className="mr-1.5 size-3" />
          {t("teams.addStatus")}
        </Button>
      </div>

      <Separator />

      {/* Subscription matrix */}
      <div className="flex flex-col gap-3">
        <Label className="text-xs font-medium text-foreground">{t("teams.subscriptionMatrix")}</Label>
        <p className="text-xs text-muted-foreground">{t("teams.subscriptionsHelp")}</p>
        <SubscriptionMatrix
          statuses={statuses}
          workers={draft.workers}
          onToggle={handleToggleSubscription}
        />
      </div>
    </div>
  )
}
