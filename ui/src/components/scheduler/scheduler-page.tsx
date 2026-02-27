import { useState, useEffect, useCallback, useMemo, useRef } from "react"
import { useTranslation } from "react-i18next"
import { useLocation } from "react-router"
import { useMediaQuery } from "usehooks-ts"
import {
  ArrowLeftIcon,
  LoaderIcon,
  AlertCircleIcon,
  WifiOffIcon,
} from "lucide-react"
import { useGatewayContext } from "@/contexts/gateway-context"
import { useChatCommands } from "@/hooks/use-chat-commands"
import { useCommandAliases } from "@/hooks/use-command-aliases"
import { Button } from "@/components/ui/button"
import { ScheduleList } from "./schedule-list"
import { SchedulerChat } from "./scheduler-chat"
import type { Schedule, SchedulerMessage, TeamConfig } from "./types"

let nextMsgId = 0
function uniqueMsgId(): string {
  return `msg-${++nextMsgId}`
}

/** How often to refresh the schedule list (ms). */
const SCHEDULE_POLL_INTERVAL_MS = 3_000
const SCHEDULER_DESKTOP_BREAKPOINT_QUERY = "(min-width: 768px)"

export function SchedulerPage() {
  const location = useLocation()
  const { t } = useTranslation()
  const isDesktop = useMediaQuery(SCHEDULER_DESKTOP_BREAKPOINT_QUERY)
  const { rpc, status, onSchedulerEvent } = useGatewayContext()
  const [teams, setTeams] = useState<TeamConfig[]>([])
  const [selectedTeamId, setSelectedTeamId] = useState<string>("")
  const [schedules, setSchedules] = useState<Schedule[]>([])
  const [messages, setMessages] = useState<SchedulerMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [mobilePane, setMobilePane] = useState<"schedules" | "chat">("schedules")
  const connectionKeyRef = useRef<string | null>(null)
  const mountedRef = useRef(true)
  const selectedTeamIdFromQuery = useMemo(
    () => new URLSearchParams(location.search).get("teamId")?.trim() ?? "",
    [location.search],
  )

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  // Fetch teams on connect
  useEffect(() => {
    if (status !== "connected") return
    rpc("chat.teams")
      .then((res) => {
        const list = (res as { teams: TeamConfig[] }).teams ?? []
        if (mountedRef.current) {
          setTeams(list)
        }
      })
      .catch(() => {})
  }, [status, rpc])

  useEffect(() => {
    if (teams.length === 0) return
    const nextTeamId = selectedTeamIdFromQuery && teams.some((team) => team.id === selectedTeamIdFromQuery)
      ? selectedTeamIdFromQuery
      : teams[0].id
    if (nextTeamId && selectedTeamId !== nextTeamId) {
      setSelectedTeamId(nextTeamId)
    }
  }, [selectedTeamIdFromQuery, teams, selectedTeamId])

  useEffect(() => {
    if (isDesktop) {
      setMobilePane("schedules")
    }
  }, [isDesktop])

  useEffect(() => {
    setMobilePane("schedules")
  }, [selectedTeamId])

  // Connect to scheduler when team changes
  useEffect(() => {
    if (status !== "connected" || !selectedTeamId) return

    let cancelled = false

    async function connect() {
      // Disconnect previous
      if (connectionKeyRef.current) {
        try {
          await rpc("scheduler.disconnect", {
            teamId: selectedTeamId,
            connectionKey: connectionKeyRef.current,
          })
        } catch { /* ignore */ }
        connectionKeyRef.current = null
      }

      try {
        const result = await rpc("scheduler.connect", { teamId: selectedTeamId }) as {
          connectionKey: string
          messages: Array<{ role: string; content: string }>
        }

        if (cancelled || !mountedRef.current) return
        connectionKeyRef.current = result.connectionKey

        // Convert session messages to scheduler messages
        const history: SchedulerMessage[] = result.messages.map((m) => ({
          id: uniqueMsgId(),
          role: m.role as "user" | "assistant",
          content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
        }))
        setMessages(history)
      } catch (err) {
        if (mountedRef.current) {
          setError(err instanceof Error ? err.message : "Failed to connect to scheduler")
        }
      }
    }

    connect()

    return () => {
      cancelled = true
      if (connectionKeyRef.current) {
        rpc("scheduler.disconnect", {
          teamId: selectedTeamId,
          connectionKey: connectionKeyRef.current,
        }).catch(() => {})
        connectionKeyRef.current = null
      }
    }
  }, [status, rpc, selectedTeamId])

  // Fetch schedules
  const fetchSchedules = useCallback(async () => {
    if (!selectedTeamId) return
    try {
      const result = await rpc("scheduler.list", { teamId: selectedTeamId }) as { schedules: Schedule[] }
      if (mountedRef.current) {
        setSchedules(result.schedules)
        setError(null)
      }
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : "Failed to load schedules")
      }
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [rpc, selectedTeamId])

  useEffect(() => {
    if (status !== "connected" || !selectedTeamId) return
    setLoading(true)
    fetchSchedules()

    // Poll for schedule list updates periodically
    const timer = setInterval(fetchSchedules, SCHEDULE_POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [status, selectedTeamId, fetchSchedules])

  // Listen for scheduler events (live messages from scheduled tasks or other connected clients)
  useEffect(() => {
    return onSchedulerEvent((e) => {
      if (e.teamId !== selectedTeamId) return
      setMessages((prev) => [
        ...prev,
        {
          id: uniqueMsgId(),
          role: e.role as "user" | "assistant",
          content: e.content,
          senderInfo: e.senderInfo,
        },
      ])
      // Refresh schedule list after any event (task execution may change nextRun/status)
      fetchSchedules()
    })
  }, [onSchedulerEvent, selectedTeamId, fetchSchedules])

  // Slash commands — shared with the main chat page
  const addSystemMessage = useCallback((text: string) => {
    setMessages((prev) => [
      ...prev,
      { id: uniqueMsgId(), role: "system" as const, content: text },
    ])
  }, [])
  const handleLearnPendingChange = useCallback((_sessionKey: string, pending: boolean) => {
    setSending(pending)
  }, [])

  const handleCommand = useChatCommands({
    rpc,
    sessionKey: `${selectedTeamId}:scheduler:main`,
    clearMessages: useCallback(() => setMessages([]), []),
    addSystemMessage,
    onSendMessage: (text: string) => { void handleSend(text) },
    onLearnPendingChange: handleLearnPendingChange,
  })
  const slashCommands = useCommandAliases(rpc)
  const handleAddAlias = useCallback(
    async (alias: string, expansion: string) => {
      await rpc("aliases.upsert", { alias, expansion })
    },
    [rpc],
  )

  // Send message to scheduler
  async function handleSend(text: string) {
    setSending(true)
    // Optimistically add user message
    setMessages((prev) => [
      ...prev,
      { id: uniqueMsgId(), role: "user", content: text, senderInfo: "Web UI" },
    ])
    try {
      const result = await rpc("scheduler.send", {
        teamId: selectedTeamId,
        message: text,
      }) as { reply: string }
      // Add assistant reply (the broadcast event also fires, but we add it here to avoid delay)
      setMessages((prev) => [
        ...prev,
        { id: uniqueMsgId(), role: "assistant", content: result.reply },
      ])
      // Refresh schedule list — the LLM may have created/paused/resumed/deleted a schedule
      fetchSchedules()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send message")
    } finally {
      setSending(false)
    }
  }

  // Direct schedule CRUD via RPC (bypasses LLM for reliability)
  async function handlePause(id: string) {
    try {
      await rpc("scheduler.pause", { teamId: selectedTeamId, scheduleId: id })
      fetchSchedules()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to pause schedule")
    }
  }

  async function handleResume(id: string) {
    try {
      await rpc("scheduler.resume", { teamId: selectedTeamId, scheduleId: id })
      fetchSchedules()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to resume schedule")
    }
  }

  async function handleDelete(id: string) {
    try {
      await rpc("scheduler.delete", { teamId: selectedTeamId, scheduleId: id })
      fetchSchedules()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete schedule")
    }
  }

  if (status !== "connected") {
    return (
      <div data-slot="scheduler-page" className="flex h-full items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <WifiOffIcon className="size-8" />
          <p className="text-sm">
            {status === "connecting" ? t("common.connecting") : t("common.disconnected")}
          </p>
        </div>
      </div>
    )
  }

  const scheduleListPane = (
    <div className="flex min-h-0 flex-1 flex-col bg-sidebar-secondary">
      <div className="flex-1 overflow-y-auto p-3">
        <ScheduleList
          schedules={schedules}
          onPause={handlePause}
          onResume={handleResume}
          onDelete={handleDelete}
          onSelect={!isDesktop ? () => setMobilePane("chat") : undefined}
        />
      </div>
    </div>
  )

  return (
    <div data-slot="scheduler-page" className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2 sm:px-4 md:px-6">
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          <h1 className="text-lg font-semibold text-foreground">{t("scheduler.title")}</h1>
          {loading && <LoaderIcon className="size-4 animate-spin text-muted-foreground" />}
          {error && (
            <span className="flex min-w-0 items-center gap-1 text-sm text-destructive">
              <AlertCircleIcon className="size-3.5 shrink-0" />
              <span className="truncate">{error}</span>
            </span>
          )}
        </div>
        {!isDesktop && (
          mobilePane === "chat" ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => setMobilePane("schedules")}>
              <ArrowLeftIcon className="size-4" />
              {t("scheduler.schedules")}
            </Button>
          ) : (
            <Button type="button" variant="outline" size="sm" onClick={() => setMobilePane("chat")}>
              {t("nav.chat")}
            </Button>
          )
        )}
      </div>

      {isDesktop ? (
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div className="flex w-72 shrink-0 flex-col border-r border-border">
            {scheduleListPane}
          </div>
          <div className="min-w-0 flex-1">
            <SchedulerChat
              messages={messages}
              connected={status === "connected" && !!selectedTeamId}
              sending={sending}
              slashCommands={slashCommands}
              onSend={handleSend}
              onCommand={handleCommand}
              onAddAlias={handleAddAlias}
            />
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-hidden">
          {mobilePane === "schedules" ? (
            scheduleListPane
          ) : (
            <SchedulerChat
              messages={messages}
              connected={status === "connected" && !!selectedTeamId}
              sending={sending}
              slashCommands={slashCommands}
              onSend={handleSend}
              onCommand={handleCommand}
              onAddAlias={handleAddAlias}
            />
          )}
        </div>
      )}
    </div>
  )
}
