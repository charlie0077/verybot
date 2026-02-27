import {
  createContext,
  useContext,
  useRef,
  useState,
  useCallback,
  useEffect,
  type ReactNode,
} from "react"
import type { ConnectionStatus, ChatDelta, AgentEvent } from "@/hooks/use-gateway"
import { pushLogEntry, replaceLogEntries } from "@/lib/log-store"
import { deriveWsUrl, loadToken, saveToken, clearToken } from "@/lib/gateway-credentials"
export type { LogEvent } from "@/lib/log-store"

const RECONNECT_DELAY_MS = 2_000
const ENV_TOKEN = import.meta.env.VITE_GATEWAY_TOKEN as string | undefined

interface PendingCall {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
}

type RpcFn = (
  method: string,
  params?: Record<string, unknown>,
) => Promise<unknown>

type SendMessageFn = (sessionKey: string, message: string, agentId?: string, images?: string[]) => void

export interface TaskChangeEvent {
  action:
    | "created"
    | "updated"
    | "deleted"
    | "archived"
    | "reordered"
    | "commentAdded"
    | "commentUpdated"
    | "commentDeleted"
  task?: unknown
  taskId?: string
  comment?: unknown
  id?: string
  count?: number
}

export interface SchedulerMessageEvent {
  teamId: string
  role: string
  content: string
  senderInfo?: string
}

export interface TeamChangeEvent {
  action: "saved" | "created" | "updated" | "deleted" | "agentCreated" | "agentUpdated" | "agentDeleted"
  teamId?: string
  id?: string
  team?: unknown
  agent?: unknown
}

export interface PromptTemplateChangeEvent {
  action: "created" | "updated" | "deleted"
  promptTemplate?: unknown
  id?: string
}

export interface PlaybookChangeEvent {
  action: "created" | "updated" | "renamed" | "deleted"
  name: string
  newName?: string
}

export type WhatsAppEvent =
  | { type: "qr"; dataUrl: string }
  | { type: "connected" }
  | { type: "disconnected" }

interface GatewayContextValue {
  status: ConnectionStatus
  /** Current auth token (null = not set). */
  token: string | null
  /** Auth error message from server rejection. */
  authError: string | null
  rpc: RpcFn
  sendMessage: SendMessageFn
  /** Set token, persist to localStorage, and reconnect. */
  setToken: (token: string) => void
  /** Clear token, close WS, return to login. */
  disconnect: () => void
  /** Register chat event listener. Returns unsubscribe function. */
  onChatEvent: (fn: (e: ChatDelta) => void) => () => void
  /** Register agent event listener. Returns unsubscribe function. */
  onAgentEvent: (fn: (e: AgentEvent) => void) => () => void
  /** Register task change event listener. Returns unsubscribe function. */
  onTaskEvent: (fn: (e: TaskChangeEvent) => void) => () => void
  /** Register scheduler message event listener. Returns unsubscribe function. */
  onSchedulerEvent: (fn: (e: SchedulerMessageEvent) => void) => () => void
  /** Register team change event listener. Returns unsubscribe function. */
  onTeamEvent: (fn: (e: TeamChangeEvent) => void) => () => void
  /** Register prompt template change event listener. Returns unsubscribe function. */
  onPromptTemplateEvent: (fn: (e: PromptTemplateChangeEvent) => void) => () => void
  /** Register playbook change event listener. Returns unsubscribe function. */
  onPlaybookEvent: (fn: (e: PlaybookChangeEvent) => void) => () => void
  /** Register WhatsApp event listener (QR code, connection status). Returns unsubscribe function. */
  onWhatsAppEvent: (fn: (e: WhatsAppEvent) => void) => () => void
  /** Activate persistent log streaming (idempotent). Subscribes on backend and feeds the log store. */
  activateLogStream: () => void
}

const GatewayContext = createContext<GatewayContextValue | null>(null)

interface GatewayProviderProps {
  children: ReactNode
}

export function GatewayProvider({ children }: GatewayProviderProps) {
  const [status, setStatus] = useState<ConnectionStatus>("disconnected")
  const [token, setTokenState] = useState<string | null>(() => loadToken() ?? ENV_TOKEN ?? null)
  const [authError, setAuthError] = useState<string | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const rpcIdRef = useRef(0)
  const pendingRef = useRef<Map<string, PendingCall>>(new Map())
  const reconnectRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const chatListeners = useRef<Set<(e: ChatDelta) => void>>(new Set())
  const agentListeners = useRef<Set<(e: AgentEvent) => void>>(new Set())
  const taskListeners = useRef<Set<(e: TaskChangeEvent) => void>>(new Set())
  const schedulerListeners = useRef<Set<(e: SchedulerMessageEvent) => void>>(new Set())
  const teamListeners = useRef<Set<(e: TeamChangeEvent) => void>>(new Set())
  const promptTemplateListeners = useRef<Set<(e: PromptTemplateChangeEvent) => void>>(new Set())
  const playbookListeners = useRef<Set<(e: PlaybookChangeEvent) => void>>(new Set())
  const whatsappListeners = useRef<Set<(e: WhatsAppEvent) => void>>(new Set())
  const logStreamActiveRef = useRef(false)
  // Track auth-connect RPC id and whether auth was rejected
  const authRpcIdRef = useRef<string | null>(null)
  const authFailedRef = useRef(false)
  // Ref for current token so reconnect closure always has the latest value
  const tokenRef = useRef(token)
  tokenRef.current = token

  const connect = useCallback(() => {
    // Close existing connection
    clearTimeout(reconnectRef.current)
    if (wsRef.current) {
      wsRef.current.onclose = null
      wsRef.current.close()
      wsRef.current = null
    }

    authFailedRef.current = false
    setAuthError(null)
    setStatus("connecting")
    const wsUrl = deriveWsUrl()
    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.onopen = () => {
      if (wsRef.current !== ws) return
      const authId = String(++rpcIdRef.current)
      authRpcIdRef.current = authId
      ws.send(
        JSON.stringify({
          id: authId,
          method: "connect",
          token: tokenRef.current ?? "",
        }),
      )
    }

    ws.onmessage = (e) => {
      if (wsRef.current !== ws) return
      // WS messages are untyped — use `any` for the raw parse
      let msg: any
      try {
        msg = JSON.parse(e.data)
      } catch {
        return
      }

      // RPC response (has id)
      if (msg.id) {
        // Check if this is the auth response
        if (msg.id === authRpcIdRef.current) {
          authRpcIdRef.current = null
          if (msg.error) {
            // Auth rejected — stop reconnect loop
            authFailedRef.current = true
            setAuthError("login.authFailed")
            setStatus("disconnected")
            ws.close()
            return
          }
          if (msg.result?.status === "ok") {
            setStatus("connected")
            return
          }
        }

        const pending = pendingRef.current.get(msg.id)
        if (pending) {
          pendingRef.current.delete(msg.id)
          if (msg.error) {
            pending.reject(new Error(msg.error.message ?? "RPC error"))
          } else {
            pending.resolve(msg.result)
          }
          return
        }
      }

      // Broadcast events
      if (msg.type === "event") {
        if (msg.event === "chat") {
          for (const fn of chatListeners.current) fn(msg.payload)
        } else if (msg.event === "agent") {
          for (const fn of agentListeners.current) fn(msg.payload)
        } else if (msg.event === "taskChange") {
          for (const fn of taskListeners.current) fn(msg.payload)
        } else if (msg.event === "schedulerMessage") {
          for (const fn of schedulerListeners.current) fn(msg.payload)
        } else if (msg.event === "teamChange") {
          for (const fn of teamListeners.current) fn(msg.payload)
        } else if (msg.event === "promptTemplateChange") {
          for (const fn of promptTemplateListeners.current) fn(msg.payload)
        } else if (msg.event === "playbookChange") {
          for (const fn of playbookListeners.current) fn(msg.payload)
        } else if (msg.event === "whatsapp") {
          for (const fn of whatsappListeners.current) fn(msg.payload)
        } else if (msg.event === "log") {
          pushLogEntry(msg.payload)
        }
      }
    }

    ws.onclose = () => {
      if (wsRef.current !== ws) return
      for (const pending of pendingRef.current.values()) {
        pending.reject(new Error("WebSocket closed"))
      }
      pendingRef.current.clear()
      setStatus("disconnected")
      wsRef.current = null
      // Only auto-reconnect if auth didn't fail
      if (!authFailedRef.current) {
        reconnectRef.current = setTimeout(connect, RECONNECT_DELAY_MS)
      }
    }

    ws.onerror = () => ws.close()
  }, [])

  // Auto-connect when token is available
  useEffect(() => {
    if (token !== null) {
      connect()
    }
    return () => {
      clearTimeout(reconnectRef.current)
      if (wsRef.current) {
        wsRef.current.onclose = null
        wsRef.current.close()
        wsRef.current = null
      }
    }
  }, [token, connect])

  const setToken = useCallback((newToken: string) => {
    saveToken(newToken)
    setAuthError(null)
    setTokenState(newToken)
  }, [])

  const disconnect = useCallback(() => {
    clearToken()
    clearTimeout(reconnectRef.current)
    if (wsRef.current) {
      wsRef.current.onclose = null
      wsRef.current.close()
      wsRef.current = null
    }
    pendingRef.current.clear()
    setAuthError(null)
    setStatus("disconnected")
    setTokenState(null)
    logStreamActiveRef.current = false
  }, [])

  const rpc: RpcFn = useCallback(
    async (method, params) => {
      const ws = wsRef.current
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        throw new Error("Not connected")
      }
      const id = String(++rpcIdRef.current)
      return new Promise((resolve, reject) => {
        pendingRef.current.set(id, { resolve, reject })
        ws.send(JSON.stringify({ id, method, params }))
      })
    },
    [],
  )

  const sendMessage: SendMessageFn = useCallback(
    (sessionKey, message, agentId, images) => {
      const ws = wsRef.current
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      const params: Record<string, unknown> = { sessionKey, message }
      if (agentId) params.agentId = agentId
      if (images?.length) params.images = images
      ws.send(
        JSON.stringify({
          id: String(++rpcIdRef.current),
          method: "chat.send",
          params,
        }),
      )
    },
    [],
  )

  const onChatEvent = useCallback((fn: (e: ChatDelta) => void) => {
    chatListeners.current.add(fn)
    return () => {
      chatListeners.current.delete(fn)
    }
  }, [])

  const onAgentEvent = useCallback((fn: (e: AgentEvent) => void) => {
    agentListeners.current.add(fn)
    return () => {
      agentListeners.current.delete(fn)
    }
  }, [])

  const onTaskEvent = useCallback((fn: (e: TaskChangeEvent) => void) => {
    taskListeners.current.add(fn)
    return () => {
      taskListeners.current.delete(fn)
    }
  }, [])

  const onSchedulerEvent = useCallback((fn: (e: SchedulerMessageEvent) => void) => {
    schedulerListeners.current.add(fn)
    return () => {
      schedulerListeners.current.delete(fn)
    }
  }, [])

  const onTeamEvent = useCallback((fn: (e: TeamChangeEvent) => void) => {
    teamListeners.current.add(fn)
    return () => {
      teamListeners.current.delete(fn)
    }
  }, [])

  const onPromptTemplateEvent = useCallback((fn: (e: PromptTemplateChangeEvent) => void) => {
    promptTemplateListeners.current.add(fn)
    return () => {
      promptTemplateListeners.current.delete(fn)
    }
  }, [])

  const onPlaybookEvent = useCallback((fn: (e: PlaybookChangeEvent) => void) => {
    playbookListeners.current.add(fn)
    return () => {
      playbookListeners.current.delete(fn)
    }
  }, [])

  const onWhatsAppEvent = useCallback((fn: (e: WhatsAppEvent) => void) => {
    whatsappListeners.current.add(fn)
    return () => {
      whatsappListeners.current.delete(fn)
    }
  }, [])

  // Activate persistent log streaming — idempotent, survives page navigation
  const activateLogStream = useCallback(() => {
    if (logStreamActiveRef.current) return
    logStreamActiveRef.current = true
    rpc("system.logs.subscribe")
      .then((res) => {
        const result = res as { logs: { ts: string; level: string; message: string }[] }
        if (result.logs) replaceLogEntries(result.logs)
      })
      .catch(() => {})
  }, [rpc])

  // Re-subscribe on reconnect if log streaming was previously activated
  useEffect(() => {
    if (status === "connected" && logStreamActiveRef.current) {
      rpc("system.logs.subscribe")
        .then((res) => {
          const result = res as { logs: { ts: string; level: string; message: string }[] }
          if (result.logs) replaceLogEntries(result.logs)
        })
        .catch(() => {})
    }
  }, [status, rpc])

  return (
    <GatewayContext.Provider
      value={{
        status, token, authError, rpc, sendMessage, setToken, disconnect,
        onChatEvent, onAgentEvent, onTaskEvent, onSchedulerEvent,
        onTeamEvent, onPromptTemplateEvent, onPlaybookEvent, onWhatsAppEvent, activateLogStream,
      }}
    >
      {children}
    </GatewayContext.Provider>
  )
}

export function useGatewayContext(): GatewayContextValue {
  const ctx = useContext(GatewayContext)
  if (!ctx) throw new Error("useGatewayContext must be used within GatewayProvider")
  return ctx
}
