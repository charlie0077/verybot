import { useState, useEffect, useCallback, useRef, useMemo } from "react"
import { useLocalStorage, useMediaQuery } from "usehooks-ts"
import { useTranslation } from "react-i18next"
import { useLocation, useNavigate } from "react-router"
import {
  LoaderIcon,
  AlertCircleIcon,
  WifiOffIcon,
  MessageSquareIcon,
  ChevronLeftIcon,
} from "lucide-react"
import { useGateway } from "@/hooks/use-gateway"
import { useGatewayContext } from "@/contexts/gateway-context"
import { useSessionTabs } from "@/hooks/use-session-tabs"
import { useChatCommands } from "@/hooks/use-chat-commands"
import { useCommandAliases } from "@/hooks/use-command-aliases"
import { Chat } from "@/components/chat"
import type { ImageAttachment } from "@/components/chat-input-bar"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { cn } from "@/lib/utils"

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface SessionEntry {
  key: string
  file: string
  messageCount: number
  updatedAt: number
  title?: string
  teamId?: string
  teamName?: string
  teamColor?: string
  channelType?: string
  agentId?: string
  agentName?: string
}

interface SessionListResponse {
  sessions?: SessionEntry[]
  total?: number
  hasMore?: boolean
  nextOffset?: number | null
}

interface ListSessionsParams extends Record<string, unknown> {
  limit: number
  offset: number
  teamId?: string
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Fallback parser for session keys when pre-parsed metadata is unavailable. */
function parseSessionKey(key: string) {
  const parts = key.split(":")
  if (parts.length >= 3) {
    return { teamId: parts[0], channel: parts[1], channelId: parts.slice(2).join(":") }
  }
  return { teamId: "", channel: "", channelId: key }
}

function formatRelativeTime(timestamp: number, t: ReturnType<typeof import("react-i18next").useTranslation>["t"]): string {
  const now = Date.now()
  const diffMs = now - timestamp
  const diffSec = Math.floor(diffMs / 1_000)
  const diffMin = Math.floor(diffSec / 60)
  const diffHour = Math.floor(diffMin / 60)
  const diffDay = Math.floor(diffHour / 24)

  if (diffSec < 60) return t("sessions.justNow")
  if (diffMin < 60) return t("sessions.minutesAgo", { count: diffMin })
  if (diffHour < 24) return t("sessions.hoursAgo", { count: diffHour })
  if (diffDay < 30) return t("sessions.daysAgo", { count: diffDay })
  return new Date(timestamp).toLocaleDateString()
}

const SELECTED_SESSION_KEY = "mvp-selected-session"
const SESSION_LIST_PAGE_SIZE = 100
const KEEP_LATEST_SESSIONS = 300
const TEAM_QUERY_PARAM = "teamId"
const MOBILE_BREAKPOINT_QUERY = "(min-width: 768px)"

const CHANNEL_COLORS: Record<string, string> = {
  gateway: "bg-muted text-muted-foreground",
  telegram: "bg-channel-telegram/20 text-channel-telegram",
  discord: "bg-channel-discord/20 text-channel-discord",
  slack: "bg-channel-slack/20 text-channel-slack",
  whatsapp: "bg-channel-whatsapp/20 text-channel-whatsapp",
  scheduler: "bg-channel-scheduler/20 text-channel-scheduler",
  worker: "bg-channel-gateway/20 text-channel-gateway",
}

function channelBadgeClass(channel: string): string {
  return CHANNEL_COLORS[channel] ?? "bg-muted text-muted-foreground"
}

function mergeSessionEntries(existing: SessionEntry[], incoming: SessionEntry[]): SessionEntry[] {
  if (existing.length === 0) return incoming
  if (incoming.length === 0) return existing

  const merged = new Map(existing.map((session) => [session.key, session]))
  for (const session of incoming) {
    merged.set(session.key, session)
  }
  return [...merged.values()]
}

function buildListSessionsParams(limit: number, offset: number, teamId: string): ListSessionsParams {
  return {
    limit,
    offset,
    ...(teamId && { teamId }),
  }
}

/** Resolve display values from enriched metadata, falling back to key parsing. */
function resolveSessionDisplay(session: SessionEntry) {
  const parsed = parseSessionKey(session.key)
  const channel = session.channelType || parsed.channel
  const teamName = session.teamName || (session.teamId && session.teamId !== "default" ? session.teamId : "")
  const agentName = session.agentName || ""
  const teamColor = session.teamColor || ""

  return { channel, teamName, agentName, teamColor }
}

/* ------------------------------------------------------------------ */
/*  Sidebar Item                                                       */
/* ------------------------------------------------------------------ */

interface SidebarItemProps {
  session: SessionEntry
  active: boolean
  running: boolean
  onSelect: (key: string) => void
  /** Whether to hide the team name (e.g. when there's only one team). */
  hideTeam: boolean
}

function SidebarItem({ session, active, running, onSelect, hideTeam }: SidebarItemProps) {
  const { t } = useTranslation()
  const { channel, teamName, agentName, teamColor } = resolveSessionDisplay(session)
  const showTeamLine = (!hideTeam && teamName) || (channel === "worker" && agentName)

  return (
    <button
      data-slot="session-sidebar-item"
      type="button"
      aria-selected={active}
      className={cn(
        "flex w-full flex-col gap-0.5 rounded-lg px-3 py-2 text-left transition-colors",
        active
          ? "bg-accent/10 text-foreground"
          : "text-muted-foreground hover:bg-accent/5 hover:text-foreground",
      )}
      onClick={() => onSelect(session.key)}
    >
      {/* Line 1: Title + time + msg count */}
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-sm font-medium">
          {session.title || session.key}
        </span>
        <div className="flex shrink-0 items-center gap-1.5">
          {running && <LoaderIcon className="size-3 animate-spin text-muted-foreground" />}
          <span className="text-[10px] text-muted-foreground tabular-nums">
            {formatRelativeTime(session.updatedAt, t)}
            {session.messageCount > 0 && ` \u00B7 ${session.messageCount}`}
          </span>
        </div>
      </div>

      {/* Line 2: Team name + worker name + channel badge */}
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          {showTeamLine && (
            <>
              {!hideTeam && teamName && (
                <span
                  className={cn(
                    "rounded px-1 py-px text-[10px] leading-tight",
                    !teamColor && "bg-muted-foreground/20 text-muted-foreground",
                  )}
                  style={teamColor ? {
                    backgroundColor: teamColor + "20",
                    color: teamColor,
                  } : undefined}
                >
                  {teamName}
                </span>
              )}
              {!hideTeam && teamName && channel === "worker" && agentName && " \u00B7 "}
              {channel === "worker" && agentName}
            </>
          )}
        </span>
        <Badge
          variant="secondary"
          className={cn("shrink-0 text-[10px] px-1.5 py-0", channelBadgeClass(channel))}
        >
          {channel}
        </Badge>
      </div>
    </button>
  )
}

/* ------------------------------------------------------------------ */
/*  Main Page                                                          */
/* ------------------------------------------------------------------ */

export function SessionsPage() {
  const { t } = useTranslation()
  const location = useLocation()
  const navigate = useNavigate()
  const isDesktop = useMediaQuery(MOBILE_BREAKPOINT_QUERY)
  const { status: gwStatus, onAgentEvent: subscribeAgentEvents } = useGatewayContext()
  const selectedTeamId = useMemo(
    () => new URLSearchParams(location.search).get(TEAM_QUERY_PARAM)?.trim() ?? "",
    [location.search],
  )
  const routeSessionKey = useMemo(
    () => new URLSearchParams(location.search).get("sessionKey"),
    [location.search],
  )

  /* ---- Chat infrastructure (same as ChatPage) ---- */

  const rpcRef = useRef<
    (method: string, params?: Record<string, unknown>) => Promise<unknown>
  >(undefined)
  const stableRpc = useCallback(
    (method: string, params?: Record<string, unknown>) =>
      rpcRef.current?.(method, params) ?? Promise.resolve(),
    [],
  )

  const {
    tabs,
    activeKey,
    messages,
    isStreaming,
    isAwaitingResponse,
    onChatEvent,
    onAgentEvent,
    resumeSession,
    addUserMessage,
    markAssistantPending,
    resolveAssistantPending,
    stopAssistantResponse,
    addSystemMessage,
    clearMessages,
    isSessionRunning,
  } = useSessionTabs(stableRpc, gwStatus)

  const { status, sendMessage, rpc } = useGateway(onChatEvent, onAgentEvent)
  rpcRef.current = rpc

  /* ---- Session list state ---- */

  const [sessions, setSessions] = useState<SessionEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [clearingOld, setClearingOld] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [totalSessions, setTotalSessions] = useState(0)
  const [nextOffset, setNextOffset] = useState(0)
  const [hasMoreSessions, setHasMoreSessions] = useState(false)
  const [selectedKey, setSelectedKey] = useLocalStorage<string | null>(SELECTED_SESSION_KEY, null)
  const selectedKeyRef = useRef<string | null>(selectedKey)
  const selectedTeamIdRef = useRef(selectedTeamId)
  const listRequestSeqRef = useRef(0)
  const previousTeamIdRef = useRef<string | null>(null)
  const autoSelected = useRef(false)
  const [clearOldOpen, setClearOldOpen] = useState(false)
  const mountedRef = useRef(true)

  useEffect(() => {
    selectedKeyRef.current = selectedKey
  }, [selectedKey])

  useEffect(() => {
    selectedTeamIdRef.current = selectedTeamId
  }, [selectedTeamId])

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  useEffect(() => {
    const previousTeamId = previousTeamIdRef.current
    if (previousTeamId === null) {
      previousTeamIdRef.current = selectedTeamId
      return
    }
    if (previousTeamId === selectedTeamId) return

    previousTeamIdRef.current = selectedTeamId
    listRequestSeqRef.current += 1
    autoSelected.current = false
    selectedKeyRef.current = null
    setSelectedKey(null)
    setSessions([])
    setTotalSessions(0)
    setHasMoreSessions(false)
    setNextOffset(0)
    setLoading(true)
    setLoadingMore(false)
    setError(null)

    const params = new URLSearchParams(location.search)
    if (params.has("sessionKey")) {
      params.delete("sessionKey")
      const search = params.toString()
      void navigate(
        {
          pathname: location.pathname,
          search: search ? `?${search}` : "",
        },
        { replace: true },
      )
    }
  }, [location.pathname, location.search, navigate, selectedTeamId, setSelectedKey])

  const uniqueTeams = new Set(sessions.map((s) => s.teamId || parseSessionKey(s.key).teamId).filter(Boolean))
  const hideTeam = uniqueTeams.size <= 1

  /* ---- Fetch session list ---- */

  const fetchSessions = useCallback(async (
    options?: { silent?: boolean; throwOnError?: boolean },
  ): Promise<SessionEntry[]> => {
    const silent = options?.silent ?? false
    const requestSeq = ++listRequestSeqRef.current
    const requestTeamId = selectedTeamId
    const isCurrentRequest = () =>
      mountedRef.current
      && requestSeq === listRequestSeqRef.current
      && requestTeamId === selectedTeamIdRef.current
    if (!silent && mountedRef.current) setLoading(true)
    try {
      const raw = await rpc(
        "sessions.list",
        buildListSessionsParams(SESSION_LIST_PAGE_SIZE, 0, requestTeamId),
      ) as SessionListResponse
      if (!isCurrentRequest()) return []
      const loaded = Array.isArray(raw?.sessions) ? raw.sessions : []
      const hasMore = Boolean(raw?.hasMore)
      const fallbackNextOffset = loaded.length
      const next = typeof raw?.nextOffset === "number"
        ? raw.nextOffset
        : hasMore ? fallbackNextOffset : 0
      if (isCurrentRequest()) {
        setSessions(loaded)
        setTotalSessions(typeof raw?.total === "number" ? raw.total : loaded.length)
        setHasMoreSessions(hasMore)
        setNextOffset(next)
        setError(null)
      }
      return loaded
    } catch (err) {
      if (isCurrentRequest()) {
        setError(err instanceof Error ? err.message : "Failed to load sessions")
      }
      if (options?.throwOnError && isCurrentRequest()) throw err
      return []
    } finally {
      if (isCurrentRequest() && !silent) setLoading(false)
    }
  }, [rpc, selectedTeamId])

  const loadMoreSessions = useCallback(async () => {
    if (loadingMore || !hasMoreSessions) return
    const requestSeq = ++listRequestSeqRef.current
    const requestTeamId = selectedTeamId
    const requestOffset = nextOffset
    const isCurrentRequest = () =>
      mountedRef.current
      && requestSeq === listRequestSeqRef.current
      && requestTeamId === selectedTeamIdRef.current
    setLoadingMore(true)
    try {
      const raw = await rpc(
        "sessions.list",
        buildListSessionsParams(SESSION_LIST_PAGE_SIZE, requestOffset, requestTeamId),
      ) as SessionListResponse
      if (!isCurrentRequest()) return
      const loaded = Array.isArray(raw?.sessions) ? raw.sessions : []
      const hasMore = Boolean(raw?.hasMore)
      const fallbackNextOffset = requestOffset + loaded.length
      const next = typeof raw?.nextOffset === "number"
        ? raw.nextOffset
        : hasMore ? fallbackNextOffset : requestOffset
      if (isCurrentRequest()) {
        setSessions((prev) => mergeSessionEntries(prev, loaded))
        setTotalSessions((prev) =>
          typeof raw?.total === "number"
            ? raw.total
            : Math.max(prev, fallbackNextOffset),
        )
        setHasMoreSessions(hasMore)
        setNextOffset(next)
        setError(null)
      }
    } catch (err) {
      if (isCurrentRequest()) {
        setError(err instanceof Error ? err.message : "Failed to load sessions")
      }
    } finally {
      if (mountedRef.current) setLoadingMore(false)
    }
  }, [hasMoreSessions, loadingMore, nextOffset, rpc, selectedTeamId])

  useEffect(() => {
    if (status !== "connected") return
    void fetchSessions()
  }, [status, fetchSessions])

  // Keep sidebar fresh when subscribed-task workers start/finish.
  useEffect(() => {
    if (status !== "connected") return
    return subscribeAgentEvents((event) => {
      if (!event.subscription) return
      void fetchSessions({ silent: true })
    })
  }, [status, subscribeAgentEvents, fetchSessions])

  /* ---- Select a session → resume it into useSessionTabs ---- */

  const syncSessionKeyInUrl = useCallback((sessionKey: string) => {
    const params = new URLSearchParams(location.search)
    if (params.get("sessionKey") === sessionKey) return
    params.set("sessionKey", sessionKey)
    const search = params.toString()
    void navigate(
      {
        pathname: location.pathname,
        search: search ? `?${search}` : "",
      },
      { replace: true },
    )
  }, [location.pathname, location.search, navigate])

  const handleSelect = useCallback(async (sessionKey: string) => {
    setSelectedKey(sessionKey)
    syncSessionKeyInUrl(sessionKey)
    try {
      const session = sessions.find((s) => s.key === sessionKey)
      await resumeSession(sessionKey, session?.title, {
        channelType: session?.channelType,
        agentId: session?.agentId,
        agentName: session?.agentName,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load session")
    }
  }, [sessions, resumeSession, setSelectedKey, syncSessionKeyInUrl])

  /* ---- Auto-select: restore from localStorage or default to first session ---- */

  useEffect(() => {
    if (loading || sessions.length === 0 || autoSelected.current) return
    const hasRouteKey = routeSessionKey && sessions.some((s) => s.key === routeSessionKey)
    const validStored = selectedKey && sessions.some((s) => s.key === selectedKey)
    const target = hasRouteKey
      ? routeSessionKey
      : validStored
        ? selectedKey
        : isDesktop ? sessions[0].key : null
    if (!target) return
    autoSelected.current = true
    void handleSelect(target)
  }, [isDesktop, loading, routeSessionKey, sessions, selectedKey, handleSelect])

  // Deep-link behavior: if URL sessionKey changes later, switch to it.
  useEffect(() => {
    if (!routeSessionKey || sessions.length === 0) return
    if (!sessions.some((s) => s.key === routeSessionKey)) return
    if (routeSessionKey === selectedKeyRef.current) return
    void handleSelect(routeSessionKey)
  }, [routeSessionKey, sessions, handleSelect])

  useEffect(() => {
    if (loading || !selectedKey) return
    if (sessions.some((session) => session.key === selectedKey)) return
    if (hasMoreSessions) return

    selectedKeyRef.current = null
    setSelectedKey(null)
    const params = new URLSearchParams(location.search)
    if (params.get("sessionKey") !== selectedKey) return
    params.delete("sessionKey")
    const search = params.toString()
    void navigate(
      {
        pathname: location.pathname,
        search: search ? `?${search}` : "",
      },
      { replace: true },
    )
  }, [hasMoreSessions, loading, location.pathname, location.search, navigate, selectedKey, sessions, setSelectedKey])

  /* ---- Send (same as ChatPage) ---- */

  const handleSend = useCallback(
    (text: string, attachedImages?: ImageAttachment[]) => {
      const imageUrls = attachedImages?.map((img) => img.dataUrl)
      const key = activeKey
      if (!key) return
      const agentId = tabs.find((t) => t.key === key)?.agentId || undefined

      addUserMessage(key, text, imageUrls)
      markAssistantPending(key)
      sendMessage(key, text, agentId, imageUrls)
    },
    [tabs, activeKey, addUserMessage, markAssistantPending, sendMessage],
  )

  const clearCurrentMessages = useCallback(() => clearMessages(activeKey), [activeKey, clearMessages])
  const addCurrentSystemMessage = useCallback((text: string) => addSystemMessage(activeKey, text), [activeKey, addSystemMessage])
  const handleStop = useCallback(async () => {
    if (!activeKey) return
    try {
      await rpc("chat.abort", { sessionKey: activeKey })
      stopAssistantResponse(activeKey)
    } catch {
      addCurrentSystemMessage("Failed to stop response.")
    }
  }, [activeKey, rpc, stopAssistantResponse, addCurrentSystemMessage])
  const handleLearnPendingChange = useCallback(
    (sessionKey: string, pending: boolean) => {
      if (!sessionKey) return
      if (pending) {
        markAssistantPending(sessionKey)
        return
      }
      resolveAssistantPending(sessionKey)
    },
    [markAssistantPending, resolveAssistantPending],
  )

  const handleCommand = useChatCommands({
    rpc,
    sessionKey: activeKey,
    clearMessages: clearCurrentMessages,
    addSystemMessage: addCurrentSystemMessage,
    onSendMessage: (text: string) => handleSend(text),
    onLearnPendingChange: handleLearnPendingChange,
    onStopResponse: stopAssistantResponse,
  })
  const slashCommands = useCommandAliases(rpc)
  const handleAddAlias = useCallback(
    async (alias: string, expansion: string) => {
      await rpc("aliases.upsert", { alias, expansion })
    },
    [rpc],
  )

  const handleClear = useCallback(async () => {
    if (!activeKey) return
    try {
      await rpc("sessions.clear", { sessionKey: activeKey })
      clearCurrentMessages()
      addCurrentSystemMessage("Session cleared.")
    } catch {
      addCurrentSystemMessage("Failed to clear session.")
    }
  }, [activeKey, rpc, clearCurrentMessages, addCurrentSystemMessage])

  const handleClearOldSessions = useCallback(async () => {
    setClearingOld(true)
    try {
      await rpc("sessions.clearOld", {
        keepLatest: KEEP_LATEST_SESSIONS,
        ...(selectedTeamId && { teamId: selectedTeamId }),
      })
      const refreshedSessions = await fetchSessions({ silent: true, throwOnError: true })
      const selected = selectedKeyRef.current
      if (selected && !refreshedSessions.some((session) => session.key === selected)) {
        let selectedStillExists = false
        try {
          const retainedWindow = await rpc(
            "sessions.list",
            buildListSessionsParams(KEEP_LATEST_SESSIONS, 0, selectedTeamId),
          ) as SessionListResponse
          const retainedSessions = Array.isArray(retainedWindow?.sessions) ? retainedWindow.sessions : []
          selectedStillExists = retainedSessions.some((session) => session.key === selected)
        } catch {
          // Keep current selection if validation fails to avoid false deselection.
          selectedStillExists = true
        }
        if (!selectedStillExists) {
          setSelectedKey(null)
        }
      }
      setClearOldOpen(false)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete old sessions")
    } finally {
      if (mountedRef.current) setClearingOld(false)
    }
  }, [fetchSessions, rpc, selectedTeamId, setSelectedKey])

  const handleBackToSessionList = useCallback(() => {
    selectedKeyRef.current = null
    setSelectedKey(null)
    const params = new URLSearchParams(location.search)
    params.delete("sessionKey")
    const search = params.toString()
    void navigate(
      {
        pathname: location.pathname,
        search: search ? `?${search}` : "",
      },
      { replace: true },
    )
  }, [location.pathname, location.search, navigate, setSelectedKey])

  /* ---- Disconnected state ---- */

  if (status !== "connected") {
    return (
      <div data-slot="sessions-page" className="flex h-full items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <WifiOffIcon className="size-8" />
          <p className="text-sm">
            {status === "connecting" ? t("common.connecting") : t("common.disconnected")}
          </p>
        </div>
      </div>
    )
  }

  const hasSelectedSession = Boolean(selectedKey)
  const showSessionSidebar = isDesktop || !hasSelectedSession
  const showSessionChat = isDesktop || hasSelectedSession

  return (
    <div data-slot="sessions-page" className="flex h-full">
      {/* Session sidebar */}
      {showSessionSidebar && (
      <div className={cn(
        "flex shrink-0 flex-col bg-sidebar-secondary",
        isDesktop ? "w-72 border-r border-border" : "w-full",
      )}>
        {/* Sidebar header */}
        <div className="flex items-center justify-between border-b border-border px-3 py-3 sm:px-4">
          <div className="flex items-center gap-2">
            <h1 className="text-sm font-semibold text-foreground">{t("sessions.title")}</h1>
            {loading && <LoaderIcon className="size-3.5 animate-spin text-muted-foreground" />}
            {!loading && (
              <Badge variant="secondary" className="text-[10px] tabular-nums">
                {totalSessions}
              </Badge>
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setClearOldOpen(true)}
            disabled={loading || totalSessions <= KEEP_LATEST_SESSIONS || clearingOld}
            className="h-7 px-2 text-xs text-destructive hover:text-destructive"
          >
            {t("sessions.clearOldSessions")}
          </Button>
        </div>

        {/* Error */}
        {error && (
          <div className="flex items-center gap-1 px-3 py-2 text-xs text-destructive sm:px-4">
            <AlertCircleIcon className="size-3" />
            {error}
          </div>
        )}
        {!loading && totalSessions > sessions.length && (
          <div className="px-3 py-1 text-[10px] text-muted-foreground sm:px-4">
            {t("sessions.showingCount", { shown: sessions.length, total: totalSessions })}
          </div>
        )}

        {/* Session list */}
        <div className="flex-1 overflow-auto px-2 py-2">
          {!loading && sessions.length === 0 ? (
            <div className="flex h-full items-center justify-center">
              <p className="text-xs text-muted-foreground">{t("sessions.noSessions")}</p>
            </div>
          ) : (
            <div className="flex flex-col">
              {sessions.map((session, idx) => (
                <div key={session.key}>
                  {idx > 0 && <div className="mx-3 border-t border-border/60" />}
                  <SidebarItem
                    session={session}
                    active={session.key === selectedKey}
                    running={isSessionRunning(session.key)}
                    onSelect={handleSelect}
                    hideTeam={hideTeam}
                  />
                </div>
              ))}
              {hasMoreSessions && (
                <div className="px-1 pt-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 w-full text-xs"
                    onClick={() => { void loadMoreSessions() }}
                    disabled={loadingMore}
                  >
                    {loadingMore && <LoaderIcon className="mr-1 size-3.5 animate-spin" />}
                    {t("sessions.loadMore", { count: SESSION_LIST_PAGE_SIZE })}
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      )}

      {/* Chat area (same Chat component as chat page) */}
      {showSessionChat && (
      <div className="flex min-w-0 flex-1 flex-col">
        {!isDesktop && hasSelectedSession && (
          <div className="flex items-center border-b border-border px-3 py-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleBackToSessionList}
              className="px-2"
            >
              <ChevronLeftIcon className="size-4" />
              {t("sessions.title")}
            </Button>
          </div>
        )}
        {!isDesktop && hasSelectedSession && error && (
          <div className="flex items-center gap-1 border-b border-border px-3 py-2 text-xs text-destructive">
            <AlertCircleIcon className="size-3 shrink-0" />
            <span className="truncate">{error}</span>
          </div>
        )}
        {selectedKey ? (
          <Chat
            key={activeKey || "__empty"}
            messages={messages}
            isStreaming={isStreaming}
            isAwaitingResponse={isAwaitingResponse}
            status={status}
            slashCommands={slashCommands}
            onSend={handleSend}
            onCommand={handleCommand}
            onAddAlias={handleAddAlias}
            onStop={handleStop}
            onClear={handleClear}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <div className="flex flex-col items-center gap-2">
              <MessageSquareIcon className="size-8 opacity-40" />
              <p className="text-sm">{t("sessions.selectSession")}</p>
            </div>
          </div>
        )}
      </div>
      )}

      {/* Clear old sessions confirmation */}
      <AlertDialog open={clearOldOpen} onOpenChange={setClearOldOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("sessions.clearOldSessionsTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("sessions.clearOldSessionsDescription", {
                count: Math.max(totalSessions - KEEP_LATEST_SESSIONS, 0),
                keepLatest: KEEP_LATEST_SESSIONS,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={clearingOld}>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => { void handleClearOldSessions() }}
              disabled={clearingOld}
            >
              {clearingOld ? t("common.loading") : t("common.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
