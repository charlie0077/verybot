import { useEffect, useRef, useState, useCallback, useSyncExternalStore } from "react"
import { useTranslation } from "react-i18next"
import { Trash2Icon, ArrowDownIcon } from "lucide-react"
import { useGatewayContext } from "@/contexts/gateway-context"
import { getLogSnapshot, subscribeLogStore, clearLogStore } from "@/lib/log-store"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

const SCROLL_BOTTOM_THRESHOLD_PX = 40

const LEVEL_STYLES: Record<string, string> = {
  error: "text-destructive",
  warn: "text-chart-3",
  info: "text-foreground",
  debug: "text-muted-foreground",
  verbose: "text-muted-foreground",
}

function levelClass(level: string): string {
  return LEVEL_STYLES[level] ?? "text-foreground"
}

export function LogsPage() {
  const { t } = useTranslation()
  const { activateLogStream } = useGatewayContext()
  const logs = useSyncExternalStore(subscribeLogStore, getLogSnapshot)
  const [autoScroll, setAutoScroll] = useState(true)

  const scrollRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  // Activate log streaming on first mount (idempotent, persists across navigations)
  useEffect(() => { activateLogStream() }, [activateLogStream])

  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    if (autoScroll) {
      bottomRef.current?.scrollIntoView({ behavior: "instant" })
    }
  }, [logs, autoScroll])

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const atBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_BOTTOM_THRESHOLD_PX
    setAutoScroll(atBottom)
  }, [])

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: "instant" })
    setAutoScroll(true)
  }, [])

  return (
    <div className="relative flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-6 py-2">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold text-foreground">{t("logs.title")}</h1>
          <Badge variant="secondary" className="text-xs tabular-nums">
            {logs.length}
          </Badge>
        </div>
        <Button variant="ghost" size="sm" onClick={clearLogStore}>
          <Trash2Icon className="mr-1.5 h-4 w-4" />
          {t("common.clear")}
        </Button>
      </div>

      {/* Log output */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-auto bg-background p-4 font-mono text-xs leading-relaxed"
      >
        {logs.length === 0 ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            {t("logs.noLogs")}
          </div>
        ) : (
          logs.map((entry, i) => (
            <div key={i} className="flex gap-2 whitespace-pre-wrap break-all py-px">
              <span className="shrink-0 text-muted-foreground">{entry.ts}</span>
              <span className={cn("w-12 shrink-0 text-right uppercase", levelClass(entry.level))}>
                {entry.level}
              </span>
              <span className={levelClass(entry.level)}>{entry.message}</span>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>

      {/* Scroll-to-bottom indicator */}
      {!autoScroll && (
        <div className="absolute bottom-6 right-6">
          <Button size="sm" variant="secondary" onClick={scrollToBottom} className="shadow-md">
            <ArrowDownIcon className="mr-1 h-3.5 w-3.5" />
            {t("logs.newLogs")}
          </Button>
        </div>
      )}
    </div>
  )
}
