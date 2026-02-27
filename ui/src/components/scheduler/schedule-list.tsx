import { useTranslation } from "react-i18next"
import {
  PlayIcon,
  PauseIcon,
  Trash2Icon,
  ClockIcon,
  RepeatIcon,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { Schedule } from "./types"

const STATUS_STYLES: Record<string, string> = {
  active: "bg-chart-3/10 text-chart-3 border-chart-3/30",
  paused: "bg-chart-4/10 text-chart-4 border-chart-4/30",
  completed: "bg-muted text-muted-foreground border-border",
  failed: "bg-destructive/10 text-destructive border-destructive/30",
}

interface ScheduleListProps {
  schedules: Schedule[]
  onPause: (id: string) => void
  onResume: (id: string) => void
  onDelete: (id: string) => void
  onSelect?: (schedule: Schedule) => void
}

export function ScheduleList({ schedules, onPause, onResume, onDelete, onSelect }: ScheduleListProps) {
  const { t } = useTranslation()
  if (schedules.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-12 text-muted-foreground">
        <ClockIcon className="size-8" />
        <p className="text-sm">{t("scheduler.noSchedules")}</p>
        <p className="text-xs">{t("scheduler.noSchedulesHint")}</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {schedules.map((s) => (
        <div
          key={s.id}
          className="flex w-full items-start justify-between gap-3 rounded-lg bg-card p-3 text-left ring-1 ring-foreground/10 transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
          onClick={() => onSelect?.(s)}
          role={onSelect ? "button" : undefined}
          tabIndex={onSelect ? 0 : undefined}
          onKeyDown={onSelect
            ? (event) => {
              if (event.currentTarget !== event.target) return
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault()
                onSelect(s)
              }
            }
            : undefined}
        >
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="flex items-center gap-2">
              {s.type === "recurring" ? (
                <RepeatIcon className="size-3.5 shrink-0 text-chart-4" />
              ) : (
                <ClockIcon className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <p className="truncate text-sm text-foreground">{s.prompt}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="outline" className={STATUS_STYLES[s.status] ?? ""}>
                {s.status}
              </Badge>
              {s.type === "recurring" && s.cron && (
                <span className="font-mono">{s.cron}</span>
              )}
              {s.nextRun && (
                <span>
                  Next: {new Date(s.nextRun).toLocaleString(undefined, {
                    timeZone: s.timezone,
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              )}
              {s.conditional && <span className="italic">[conditional]</span>}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {s.status === "active" && (
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                onKeyDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation()
                  onPause(s.id)
                }}
              >
                <PauseIcon className="size-3.5" />
              </Button>
            )}
            {s.status === "paused" && (
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                onKeyDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation()
                  onResume(s.id)
                }}
              >
                <PlayIcon className="size-3.5" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-destructive"
              onKeyDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation()
                onDelete(s.id)
              }}
            >
              <Trash2Icon className="size-3.5" />
            </Button>
          </div>
        </div>
      ))}
    </div>
  )
}
