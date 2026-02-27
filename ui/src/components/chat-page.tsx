import { useCallback, useEffect, useRef, useState } from "react"
import { useLocation, useNavigate } from "react-router"
import { useGateway } from "@/hooks/use-gateway"
import { useGatewayContext } from "@/contexts/gateway-context"
import { useSessionTabs } from "@/hooks/use-session-tabs"
import { useChatCommands } from "@/hooks/use-chat-commands"
import { useCommandAliases } from "@/hooks/use-command-aliases"
import { useSessionResumeRegister, useStartSessionRegister } from "@/contexts/session-resume-context"
import { TabBar } from "@/components/tab-bar"
import { Chat } from "@/components/chat"
import type { ImageAttachment } from "@/components/chat-input-bar"
import type { TeamInfo } from "@/components/team-picker"

const NEW_TAB_SHORTCUT_KEY = "t"
const GLOBAL_CHAT_TABS_STORAGE_KEY = "verybot-tabs"
const PENDING_START_SESSION_STATE_KEY = "pendingStartSession"

interface PendingStartSession {
  requestId: string
  teamId: string
  message: string
}

function buildTeamTabsStorageKey(teamId: string): string {
  return `verybot-tabs:team:${teamId}`
}

function getPendingStartSession(state: unknown): PendingStartSession | null {
  if (!state || typeof state !== "object") return null
  const pending = (state as Record<string, unknown>)[PENDING_START_SESSION_STATE_KEY]
  if (!pending || typeof pending !== "object") return null

  const requestId = (pending as Record<string, unknown>).requestId
  const teamId = (pending as Record<string, unknown>).teamId
  const message = (pending as Record<string, unknown>).message
  if (typeof requestId !== "string" || typeof teamId !== "string" || typeof message !== "string") {
    return null
  }
  return { requestId, teamId, message }
}

function isEditableKeyTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT"
}

/**
 * Chat page — tab bar + active chat panel.
 * Owns the gateway connection and session tab state.
 */
export function ChatPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const isChatRoute = location.pathname === "/" || location.pathname === "/chat"
  const selectedTeamId = new URLSearchParams(location.search).get("teamId")?.trim() ?? ""
  const lastChatTeamIdRef = useRef(selectedTeamId)
  if (isChatRoute) {
    lastChatTeamIdRef.current = selectedTeamId
  }
  const scopedTeamId = isChatRoute ? selectedTeamId : lastChatTeamIdRef.current
  const tabsStorageKey =
    scopedTeamId
      ? buildTeamTabsStorageKey(scopedTeamId)
      : GLOBAL_CHAT_TABS_STORAGE_KEY

  /* Stable rpc ref so useSessionTabs can call the gateway without
     a circular hook dependency (useGateway needs onChatEvent from
     useSessionTabs, but useSessionTabs needs rpc from useGateway). */
  const rpcRef = useRef<
    (method: string, params?: Record<string, unknown>) => Promise<unknown>
  >(undefined)
  const stableRpc = useCallback(
    (method: string, params?: Record<string, unknown>) =>
      rpcRef.current?.(method, params) ?? Promise.resolve(),
    [],
  )

  // Get status from the shared gateway context so useSessionTabs
  // can trigger message reloading when the connection is established.
  const { status: gwStatus, onTeamEvent } = useGatewayContext()

  const {
    tabs,
    activeKey,
    messages,
    isStreaming,
    isAwaitingResponse,
    onChatEvent,
    onAgentEvent,
    addTab,
    resumeSession,
    closeTab,
    closeAllTabs,
    switchTab,
    renameTab,
    syncTeamMetadata,
    addUserMessage,
    markAssistantPending,
    resolveAssistantPending,
    stopAssistantResponse,
    addSystemMessage,
    clearMessages,
    isSessionRunning,
  } = useSessionTabs(stableRpc, gwStatus, tabsStorageKey)

  const { status, sendMessage, rpc } = useGateway(onChatEvent, onAgentEvent)
  rpcRef.current = rpc

  // Register resumeSession so other pages (e.g. SessionsPage) can open sessions.
  // Use a ref to avoid re-registration churn when resumeSession identity changes.
  const registerResume = useSessionResumeRegister()
  const resumeRef = useRef(resumeSession)
  resumeRef.current = resumeSession
  useEffect(() => {
    registerResume((key, title, meta) => resumeRef.current(key, title, meta))
  }, [registerResume])

  // Register startSession so other pages (e.g. TasksPage) can open a new chat with a message.
  const registerStart = useStartSessionRegister()
  const startSessionRef = useRef<(teamId: string, message: string) => Promise<void>>(async () => {})
  const consumedPendingStartIdsRef = useRef(new Set<string>())
  startSessionRef.current = async (teamId: string, message: string) => {
    const res = await rpcRef.current?.("chat.teams")
    const allTeams = ((res as { teams: TeamInfo[] })?.teams ?? [])
    const team = allTeams.find((t) => t.id === teamId)
    if (!team) return
    const key = addTab(team.id, team.orchestratorId || undefined, team.name, team.color)
    addUserMessage(key, message)
    markAssistantPending(key)
    sendMessage(key, message, team.orchestratorId || undefined)
  }
  useEffect(() => {
    registerStart((teamId, message) => startSessionRef.current(teamId, message))
  }, [registerStart])

  useEffect(() => {
    if (!isChatRoute) return
    const pending = getPendingStartSession(location.state)
    if (!pending) return
    if (consumedPendingStartIdsRef.current.has(pending.requestId)) return

    consumedPendingStartIdsRef.current.add(pending.requestId)
    void startSessionRef.current(pending.teamId, pending.message).catch(() => {})
    void navigate(
      { pathname: location.pathname, search: location.search },
      { replace: true, state: null },
    )
  }, [isChatRoute, location.pathname, location.search, location.state, navigate])

  /* Fetch available teams on connect */
  const [teams, setTeams] = useState<TeamInfo[]>([])
  const routedTeamIdRef = useRef("")

  const fetchTeams = useCallback(() => {
    if (status !== "connected") return
    rpc("chat.teams")
      .then((res) => {
        const list = (res as { teams: TeamInfo[] }).teams ?? []
        setTeams(list)
        syncTeamMetadata(list)
      })
      .catch(() => setTeams([]))
  }, [status, rpc, syncTeamMetadata])

  // Initial fetch on connect
  useEffect(() => { fetchTeams() }, [fetchTeams])

  // Auto-refresh teams when a teamChange event arrives
  useEffect(() => {
    return onTeamEvent(() => fetchTeams())
  }, [onTeamEvent, fetchTeams])

  const createTabForCurrentScope = useCallback(() => {
    if (!selectedTeamId) return addTab()
    const team = teams.find((item) => item.id === selectedTeamId)
    return addTab(
      selectedTeamId,
      team?.orchestratorId || undefined,
      team?.name,
      team?.color,
    )
  }, [selectedTeamId, teams, addTab])

  // Support direct team navigation from sidebar links: /chat?teamId=<id>
  // Do not auto-create a tab on navigation; only switch to an existing team tab.
  useEffect(() => {
    if (!isChatRoute || status !== "connected" || !selectedTeamId) {
      routedTeamIdRef.current = ""
      return
    }
    if (routedTeamIdRef.current === selectedTeamId) return

    const targetTeam = teams.find((team) => team.id === selectedTeamId)
    if (!targetTeam) return

    const activeTabTeamId = activeKey.split(":")[0] ?? ""
    if (activeTabTeamId === targetTeam.id) {
      routedTeamIdRef.current = selectedTeamId
      return
    }

    const existingTab = tabs.find((tab) => (tab.key.split(":")[0] ?? "") === targetTeam.id)
    if (existingTab) {
      switchTab(existingTab.key)
    }
    routedTeamIdRef.current = selectedTeamId
  }, [isChatRoute, status, selectedTeamId, teams, activeKey, tabs, switchTab])

  const handleAddTab = useCallback(() => {
    createTabForCurrentScope()
  }, [createTabForCurrentScope])

  useEffect(() => {
    if (!isChatRoute) return

    function handleGlobalKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.repeat) return
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
      if (isEditableKeyTarget(event.target)) return
      if (event.key.toLowerCase() !== NEW_TAB_SHORTCUT_KEY) return

      event.preventDefault()
      handleAddTab()
    }

    document.addEventListener("keydown", handleGlobalKeyDown)
    return () => document.removeEventListener("keydown", handleGlobalKeyDown)
  }, [handleAddTab, isChatRoute])

  const handleSend = useCallback(
    (text: string, attachedImages?: ImageAttachment[]) => {
      const imageUrls = attachedImages?.map((img) => img.dataUrl)
      let key: string
      let agentId: string | undefined

      if (tabs.length === 0) {
        // addTab returns the key synchronously (state update is async,
        // but the key is available immediately via return value)
        key = createTabForCurrentScope()
      } else {
        key = activeKey
        agentId = tabs.find((t) => t.key === key)?.agentId || undefined
      }

      if (!key) return
      addUserMessage(key, text, imageUrls)
      markAssistantPending(key)
      sendMessage(key, text, agentId, imageUrls)
    },
    [tabs, activeKey, createTabForCurrentScope, addUserMessage, markAssistantPending, sendMessage],
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

  return (
    <div data-slot="chat-page" className="flex h-full flex-col">
      <TabBar
        tabs={tabs}
        activeKey={activeKey}
        isSessionRunning={isSessionRunning}
        onSwitch={switchTab}
        onAdd={handleAddTab}
        onClose={closeTab}
        onCloseAll={closeAllTabs}
        onRename={renameTab}
      />
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
    </div>
  )
}
