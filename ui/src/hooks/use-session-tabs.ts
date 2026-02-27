import { useState, useRef, useCallback, useEffect, useLayoutEffect } from "react"
import type { ChatDelta, AgentEvent, ConnectionStatus } from "@/hooks/use-gateway"
import { createClientId } from "@/lib/utils"

type RpcFn = (method: string, params?: Record<string, unknown>) => Promise<unknown>

const DEFAULT_STORAGE_KEY = "verybot-tabs"
const TEAM_STORAGE_KEY_PREFIX = "verybot-tabs:team:"
const MAX_NAME_LEN = 30
const DEFAULT_NAME = "New Chat"
const EMPTY_HISTORY_RETRY_DELAY_MS = 800
const MAX_EMPTY_HISTORY_RETRIES = 8

export interface TabInfo {
  key: string
  name: string
  /** Team agent bound to this tab (orchestrator or worker). */
  agentId?: string
  /** Human-readable team name for display in the tab badge. */
  teamName?: string
  /** Team color for visual identification. */
  teamColor?: string
}

export interface ResumeSessionMeta {
  channelType?: string
  agentId?: string
  agentName?: string
}

export interface Message {
  id: string
  role: "user" | "assistant" | "tool" | "system"
  content: string
  streaming?: boolean
  toolName?: string
  /** Base64 data URLs for user-attached images. */
  images?: string[]
}

interface SessionHistoryMessage {
  role: string
  content: unknown
}

function toUiRole(role: string): Message["role"] {
  if (role === "user" || role === "assistant" || role === "tool" || role === "system") {
    return role
  }
  return "assistant"
}

function mapHistoryToDisplayMessages(history: SessionHistoryMessage[]): Message[] {
  return history.flatMap((item) => {
    const role = toUiRole(item.role)
    if (role === "tool") return []
    const { text, images } = parseMessageContent(item.content)
    return [{ id: createClientId(), role, content: text, images }]
  })
}

/** Parse backend message content which may be a plain string or a multimodal array. */
export function parseMessageContent(content: unknown): { text: string; images?: string[] } {
  if (typeof content === "string") {
    // Handle legacy stringified JSON arrays from older sessions
    if (content.startsWith("[{") && content.includes('"type"')) {
      try {
        return parseMessageContent(JSON.parse(content))
      } catch { /* not JSON, treat as plain text */ }
    }
    return { text: content }
  }
  if (!Array.isArray(content)) return { text: String(content ?? "") }

  const texts: string[] = []
  const images: string[] = []

  for (const part of content) {
    if (typeof part === "string") {
      texts.push(part)
    } else if (part?.type === "text" && part.text) {
      texts.push(part.text)
    } else if (part?.type === "image" && part.image) {
      const img = toImageSrc(part.image, part.mediaType)
      if (img) images.push(img)
    } else if (part?.type === "image_url" && part.image_url?.url) {
      images.push(part.image_url.url)
    } else if (part?.type === "file" && isImageMediaType(part.mediaType)) {
      const img = toImageSrc(part.data, part.mediaType)
      if (img) images.push(img)
    } else if (part?.type === "tool-result" && part.output) {
      const output = part.output as { type?: string; value?: unknown }
      if (output.type === "text" && typeof output.value === "string") {
        texts.push(output.value)
      } else if (output.type === "content" && Array.isArray(output.value)) {
        for (const item of output.value) {
          if (!item || typeof item !== "object") continue
          const valuePart = item as Record<string, unknown>
          if (valuePart.type === "text" && typeof valuePart.text === "string") {
            texts.push(valuePart.text)
            continue
          }
          if (valuePart.type === "image-data" && typeof valuePart.data === "string") {
            const mediaType = isImageMediaType(valuePart.mediaType) ? valuePart.mediaType : "image/png"
            images.push(`data:${mediaType};base64,${valuePart.data}`)
            continue
          }
          if (valuePart.type === "image-url" && typeof valuePart.url === "string") {
            images.push(valuePart.url)
            continue
          }
          if (valuePart.type === "media" && isImageMediaType(valuePart.mediaType) && typeof valuePart.data === "string") {
            images.push(`data:${valuePart.mediaType};base64,${valuePart.data}`)
            continue
          }
          if (valuePart.type === "file-data" && isImageMediaType(valuePart.mediaType) && typeof valuePart.data === "string") {
            images.push(`data:${valuePart.mediaType};base64,${valuePart.data}`)
          }
        }
      }
    }
  }

  return {
    text: texts.join("\n"),
    images: images.length > 0 ? images : undefined,
  }
}

function toImageSrc(data: unknown, mediaType: unknown): string | null {
  if (typeof data !== "string") return null
  if (data.startsWith("data:")) return data
  if (isUrlLike(data)) return data
  if (isSvgMediaType(mediaType) && looksLikeSvgMarkup(data)) {
    return `data:image/svg+xml;utf8,${encodeURIComponent(data)}`
  }
  const mime = isImageMediaType(mediaType) ? mediaType : "image/png"
  return `data:${mime};base64,${data}`
}

function isImageMediaType(mediaType: unknown): mediaType is string {
  return typeof mediaType === "string" && mediaType.toLowerCase().startsWith("image/")
}

function isSvgMediaType(mediaType: unknown): boolean {
  return typeof mediaType === "string" && mediaType.toLowerCase() === "image/svg+xml"
}

function looksLikeSvgMarkup(value: string): boolean {
  const trimmed = value.trim().toLowerCase()
  return trimmed.startsWith("<svg") || trimmed.startsWith("<?xml")
}

function isUrlLike(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://") || value.startsWith("blob:") || value.startsWith("/")
}

const DEFAULT_TEAM_ID = "default"
const WORKER_SESSION_MIN_PARTS = 5

function genKey(teamId = DEFAULT_TEAM_ID): string {
  return teamId + ":gateway:" + Math.random().toString(36).slice(2, 10)
}

function truncName(s: string): string {
  const t = s.trim()
  return t.length <= MAX_NAME_LEN ? t : t.slice(0, MAX_NAME_LEN - 1) + "\u2026"
}

function getScopedTeamIdFromStorageKey(storageKey: string): string | undefined {
  if (!storageKey.startsWith(TEAM_STORAGE_KEY_PREFIX)) return undefined
  const scopedTeamId = storageKey.slice(TEAM_STORAGE_KEY_PREFIX.length).trim()
  return scopedTeamId || undefined
}

function getTeamIdFromSessionKey(sessionKey: string): string {
  return sessionKey.split(":")[0] ?? DEFAULT_TEAM_ID
}

function parseResumeSessionKey(sessionKey: string): {
  teamId: string
  channelId: string
  isWorker: boolean
  workerName?: string
} {
  const parts = sessionKey.split(":")
  const lastPart = parts[parts.length - 1] ?? ""
  const isWorker = parts.length >= WORKER_SESSION_MIN_PARTS && /^\d+$/.test(lastPart)
  return {
    teamId: parts[0] ?? DEFAULT_TEAM_ID,
    channelId: parts.slice(2).join(":") || sessionKey,
    isWorker,
    workerName: isWorker ? parts[parts.length - 2] : undefined,
  }
}

/* ---- Persistence ---- */

interface Saved {
  tabs: TabInfo[]
  activeKey: string
}

function toOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function sanitizeSavedTab(value: unknown, scopedTeamId?: string): TabInfo | null {
  if (!value || typeof value !== "object") return null
  const record = value as Record<string, unknown>
  const key = typeof record.key === "string" ? record.key.trim() : ""
  if (!key) return null
  if (scopedTeamId && getTeamIdFromSessionKey(key) !== scopedTeamId) return null

  const rawName = typeof record.name === "string" && record.name.trim() ? record.name : DEFAULT_NAME
  return {
    key,
    name: truncName(rawName),
    agentId: toOptionalString(record.agentId),
    teamName: toOptionalString(record.teamName),
    teamColor: toOptionalString(record.teamColor),
  }
}

function sanitizeSavedState(value: unknown, storageKey: string): Saved | null {
  if (!value || typeof value !== "object") return null
  const record = value as Record<string, unknown>
  if (!Array.isArray(record.tabs)) return null
  const scopedTeamId = getScopedTeamIdFromStorageKey(storageKey)

  const seenKeys = new Set<string>()
  const tabsReversed: TabInfo[] = []
  for (let index = record.tabs.length - 1; index >= 0; index -= 1) {
    const tab = sanitizeSavedTab(record.tabs[index], scopedTeamId)
    if (!tab || seenKeys.has(tab.key)) continue
    seenKeys.add(tab.key)
    tabsReversed.push(tab)
  }
  const tabs = tabsReversed.reverse()
  if (tabs.length === 0) return null

  const savedActiveKey = typeof record.activeKey === "string" ? record.activeKey : ""
  const activeKey = tabs.some((tab) => tab.key === savedActiveKey)
    ? savedActiveKey
    : tabs[tabs.length - 1].key
  return { tabs, activeKey }
}

function loadSaved(storageKey: string): Saved | null {
  try {
    const raw = localStorage.getItem(storageKey)
    if (!raw) return null
    return sanitizeSavedState(JSON.parse(raw), storageKey)
  } catch {
    return null
  }
}

function saveTabs(storageKey: string, tabs: TabInfo[], activeKey: string) {
  localStorage.setItem(storageKey, JSON.stringify({ tabs, activeKey }))
}

/* ---- Stream context per tab ---- */

interface StreamCtx {
  id: string
  buffer: string
}

/* ---- Hook ---- */

export function useSessionTabs(
  rpc?: RpcFn,
  status?: ConnectionStatus,
  storageKey = DEFAULT_STORAGE_KEY,
) {
  /* Tab list — start empty; first tab is created once teams are known */
  const initial = useRef(loadSaved(storageKey))
  const stateStorageKeyRef = useRef(storageKey)
  const [tabs, setTabs] = useState<TabInfo[]>(
    () => initial.current?.tabs ?? [],
  )
  const [activeKey, setActiveKey] = useState(
    () => initial.current?.activeKey ?? "",
  )
  const activeKeyRef = useRef(activeKey)
  activeKeyRef.current = activeKey

  /* Set of open tab keys for filtering events */
  const tabKeysRef = useRef(new Set(tabs.map((t) => t.key)))
  useEffect(() => {
    tabKeysRef.current = new Set(tabs.map((t) => t.key))
  }, [tabs])

  /* Source of truth: all messages + stream contexts in refs */
  const msgs = useRef(new Map<string, Message[]>())
  const streams = useRef(new Map<string, StreamCtx>())
  const awaitingReplies = useRef(new Map<string, number>())

  /* Track which session keys have been loaded from the server */
  const loadedKeys = useRef(new Set<string>())
  const resumingKeys = useRef(new Set<string>())
  const emptyHistoryRetryCounts = useRef(new Map<string, number>())
  const emptyHistoryRetryTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  /* Re-render trigger for active tab data changes */
  const [, rerender] = useState(0)
  const bump = useCallback(() => rerender((v) => v + 1), [])

  const clearEmptyHistoryRetry = useCallback((sessionKey: string) => {
    emptyHistoryRetryCounts.current.delete(sessionKey)
    const retryTimer = emptyHistoryRetryTimers.current.get(sessionKey)
    if (retryTimer) {
      clearTimeout(retryTimer)
      emptyHistoryRetryTimers.current.delete(sessionKey)
    }
  }, [])

  useEffect(() => {
    return () => {
      for (const retryTimer of emptyHistoryRetryTimers.current.values()) {
        clearTimeout(retryTimer)
      }
      emptyHistoryRetryTimers.current.clear()
      emptyHistoryRetryCounts.current.clear()
    }
  }, [])

  /* Switch local tab state when navigating between chat scopes (global vs team chat). */
  useLayoutEffect(() => {
    if (stateStorageKeyRef.current === storageKey) return

    const saved = loadSaved(storageKey)
    const nextTabs = saved?.tabs ?? []
    const nextActiveKey = saved?.activeKey ?? ""

    setTabs(nextTabs)
    setActiveKey(nextActiveKey)
    activeKeyRef.current = nextActiveKey

    tabKeysRef.current = new Set(nextTabs.map((t) => t.key))
    msgs.current.clear()
    streams.current.clear()
    awaitingReplies.current.clear()
    loadedKeys.current.clear()
    resumingKeys.current.clear()
    for (const retryTimer of emptyHistoryRetryTimers.current.values()) {
      clearTimeout(retryTimer)
    }
    emptyHistoryRetryTimers.current.clear()
    emptyHistoryRetryCounts.current.clear()

    stateStorageKeyRef.current = storageKey
    bump()
  }, [storageKey, bump])

  /* Derived values (recalculated each render) */
  const messages = msgs.current.get(activeKey) ?? []
  const isStreaming = streams.current.has(activeKey)
  const isAwaitingResponse = (awaitingReplies.current.get(activeKey) ?? 0) > 0

  /* Persist tab metadata */
  useEffect(() => {
    saveTabs(storageKey, tabs, activeKey)
  }, [storageKey, tabs, activeKey])

  /** Load messages from the server for a given session key (idempotent). */
  const loadSessionMessages = useCallback(
    async (sessionKey: string) => {
      if (!rpc || !sessionKey || loadedKeys.current.has(sessionKey)) return
      loadedKeys.current.add(sessionKey)
      try {
        const raw = await rpc("sessions.get", { sessionKey })
        const result = raw as { messages?: SessionHistoryMessage[] } | undefined
        const history = Array.isArray(result?.messages) ? result.messages : []
        if (history.length === 0) {
          if ((msgs.current.get(sessionKey) ?? []).length === 0) {
            // Keep empty loads retryable to avoid races with delayed backend persistence.
            loadedKeys.current.delete(sessionKey)
            const retryCount = (emptyHistoryRetryCounts.current.get(sessionKey) ?? 0) + 1
            if (retryCount <= MAX_EMPTY_HISTORY_RETRIES) {
              emptyHistoryRetryCounts.current.set(sessionKey, retryCount)
              if (!emptyHistoryRetryTimers.current.has(sessionKey)) {
                const timer = setTimeout(() => {
                  emptyHistoryRetryTimers.current.delete(sessionKey)
                  void loadSessionMessages(sessionKey)
                }, EMPTY_HISTORY_RETRY_DELAY_MS)
                emptyHistoryRetryTimers.current.set(sessionKey, timer)
              }
            }
          }
          return
        }
        clearEmptyHistoryRetry(sessionKey)
        // Only populate if still empty (streaming may have added messages since)
        if ((msgs.current.get(sessionKey) ?? []).length > 0) return
        const loaded = mapHistoryToDisplayMessages(history)
        msgs.current.set(sessionKey, loaded)
        if (sessionKey === activeKeyRef.current) bump()
      } catch (err) {
        // Server may not support sessions.get yet — allow retry on next switch
        loadedKeys.current.delete(sessionKey)
        if (err instanceof Error && !err.message.includes("not found")) {
          console.warn("[useSessionTabs] loadSessionMessages failed:", err.message)
        }
      }
    },
    [rpc, bump, clearEmptyHistoryRetry],
  )

  /* Restore messages for persisted tabs on reconnect / mount and tab switches. */
  useEffect(() => {
    if (status !== "connected" || !activeKey) return
    void loadSessionMessages(activeKey)
  }, [status, activeKey, loadSessionMessages])

  /* ---- Internal helpers ---- */

  const mutate = useCallback(
    (key: string, fn: (prev: Message[]) => Message[]) => {
      msgs.current.set(key, fn(msgs.current.get(key) ?? []))
      if ((msgs.current.get(key) ?? []).length > 0) {
        clearEmptyHistoryRetry(key)
      }
      if (key === activeKeyRef.current) bump()
    },
    [bump, clearEmptyHistoryRetry],
  )

  const markAssistantPending = useCallback(
    (key: string) => {
      if (!key) return
      const nextCount = (awaitingReplies.current.get(key) ?? 0) + 1
      awaitingReplies.current.set(key, nextCount)
      bump()
    },
    [bump],
  )

  const consumeAssistantPending = useCallback(
    (key: string) => {
      const count = awaitingReplies.current.get(key) ?? 0
      if (count <= 0) return
      if (count === 1) {
        awaitingReplies.current.delete(key)
      } else {
        awaitingReplies.current.set(key, count - 1)
      }
      bump()
    },
    [bump],
  )

  const resolveAssistantPending = useCallback(
    (key: string) => {
      if (!key) return
      consumeAssistantPending(key)
    },
    [consumeAssistantPending],
  )

  /** Stop UI streaming/pending state for a session after an explicit abort. */
  const stopAssistantResponse = useCallback(
    (key: string) => {
      if (!key) return

      const ctx = streams.current.get(key)
      if (ctx) {
        const { id } = ctx
        mutate(key, (prev) =>
          prev.map((m) =>
            m.id === id ? { ...m, streaming: false } : m,
          ),
        )
        streams.current.delete(key)
      }

      if (awaitingReplies.current.has(key)) {
        awaitingReplies.current.delete(key)
        if (!ctx && key === activeKeyRef.current) bump()
      }
      if (key !== activeKeyRef.current) bump()
    },
    [mutate, bump],
  )

  useEffect(() => {
    if (status === "connected") return
    if (awaitingReplies.current.size === 0) return
    awaitingReplies.current.clear()
    bump()
  }, [status, bump])

  /* ---- Gateway event handlers ---- */

  const onChatEvent = useCallback(
    (e: ChatDelta) => {
      const key = e.sessionKey
      if (!tabKeysRef.current.has(key)) return

      if (e.state === "delta" && e.delta) {
        let ctx = streams.current.get(key)
        if (!ctx) {
          consumeAssistantPending(key)
          ctx = { id: createClientId(), buffer: "" }
          streams.current.set(key, ctx)
          const msg: Message = {
            id: ctx.id,
            role: "assistant",
            content: "",
            streaming: true,
          }
          mutate(key, (prev) => [...prev, msg])
        }
        ctx.buffer += e.delta
        const { id, buffer } = ctx
        mutate(key, (prev) =>
          prev.map((m) => (m.id === id ? { ...m, content: buffer } : m)),
        )
      }

      if (e.state === "final") {
        const ctx = streams.current.get(key)
        const parsed = parseMessageContent(e.message?.content ?? ctx?.buffer ?? "")
        const content = parsed.text || ctx?.buffer || ""
        const images = parsed.images

        if (ctx) {
          const { id } = ctx
          mutate(key, (prev) =>
            prev.map((m) =>
              m.id === id ? { ...m, content, images, streaming: false } : m,
            ),
          )
        } else {
          consumeAssistantPending(key)
          const assistantMessage: Message = {
            id: createClientId(),
            role: "assistant" as const,
            content,
          }
          if (images?.length) assistantMessage.images = images
          mutate(key, (prev) => [
            ...prev,
            assistantMessage,
          ])
        }

        streams.current.delete(key)
        if (key !== activeKeyRef.current) bump()
      }
    },
    [mutate, consumeAssistantPending],
  )

  const onAgentEvent = useCallback(
    (e: AgentEvent) => {
      const key = e.sessionKey
      if (!tabKeysRef.current.has(key)) return

      /** Insert a tool message before the trailing assistant message (if any)
       *  so tool indicators render above the response text, not below it. */
      const insertBeforeAssistant = (msg: Message) => {
        mutate(key, (prev) => {
          const last = prev.length > 0 ? prev[prev.length - 1] : undefined
          if (last?.role === "assistant") {
            const copy = [...prev]
            copy.splice(prev.length - 1, 0, msg)
            return copy
          }
          return [...prev, msg]
        })
      }

      // Handle delegation events
      if (e.delegation) {
        const d = e.delegation
        const label = d.agentName ?? d.agentId
        const content =
          d.status === "started"
            ? `Delegating to ${label}...`
            : d.status === "completed"
              ? `${label} completed (${d.resultLength} chars)`
              : `${label} failed: ${d.error}`
        insertBeforeAssistant({
          id: createClientId(),
          role: "tool" as const,
          content,
          toolName: `delegate:${label}`,
        })
        return
      }

      // Handle subscribed task worker lifecycle events
      if (e.subscription) {
        const s = e.subscription
        const label = s.agentName ?? s.agentId
        const content =
          s.status === "started"
            ? `${label} started task #${s.taskId}`
            : s.status === "completed"
              ? `${label} completed task #${s.taskId} (${s.resultLength ?? 0} chars)`
              : `${label} failed task #${s.taskId}: ${s.error ?? "unknown error"}`
        insertBeforeAssistant({
          id: createClientId(),
          role: "tool" as const,
          content,
          toolName: `task:${s.taskId}`,
        })
        return
      }

      // Do not surface raw model tool-call payloads in chat bubbles.
    },
    [mutate],
  )

  /* ---- Tab operations ---- */

  const addTab = useCallback((teamId?: string, agentId?: string, teamName?: string, teamColor?: string): string => {
    const key = genKey(teamId)
    tabKeysRef.current.add(key)
    loadedKeys.current.add(key) // new tab — nothing to fetch
    setTabs((prev) => [...prev, { key, name: DEFAULT_NAME, agentId, teamName, teamColor }])
    setActiveKey(key)
    activeKeyRef.current = key
    bump()
    return key
  }, [bump])

  /** Resume an existing session by key, loading its messages into a new tab. */
  const resumeSession = useCallback(
    async (sessionKey: string, title?: string, meta?: ResumeSessionMeta) => {
      // If tab already open, just switch to it
      if (tabKeysRef.current.has(sessionKey)) {
        setActiveKey(sessionKey)
        activeKeyRef.current = sessionKey
        bump()
        return
      }
      if (resumingKeys.current.has(sessionKey)) return

      if (!rpc) throw new Error("Gateway not connected")
      resumingKeys.current.add(sessionKey)

      try {
        // Load messages + resolve team in parallel
        const [msgRaw, teamsRaw] = await Promise.all([
          rpc("sessions.get", { sessionKey }),
          rpc("chat.teams").catch(() => ({ teams: [] })),
        ])
        const msgResult = msgRaw as { messages?: SessionHistoryMessage[] } | undefined
        const history = Array.isArray(msgResult?.messages) ? msgResult.messages : []

        const parsedKey = parseResumeSessionKey(sessionKey)
        const teamId = parsedKey.teamId
        const channelId = parsedKey.channelId
        const channelType = meta?.channelType || (parsedKey.isWorker ? "worker" : "gateway")

        const teamsList = (
          teamsRaw as {
            teams?: {
              id: string
              name: string
              color?: string
              orchestratorId: string
              workers?: { id: string; name: string }[]
            }[]
          }
        )?.teams
        const team = Array.isArray(teamsList) ? teamsList.find((t) => t.id === teamId) : undefined

        let resolvedAgentId = meta?.agentId
        if (!resolvedAgentId && channelType === "worker") {
          const workerName = meta?.agentName || parsedKey.workerName
          resolvedAgentId = workerName ? team?.workers?.find((worker) => worker.name === workerName)?.id : undefined
        }
        if (!resolvedAgentId && channelType !== "worker") {
          resolvedAgentId = team?.orchestratorId
        }

        tabKeysRef.current.add(sessionKey)
        loadedKeys.current.add(sessionKey) // already fetched above
        const firstUser = history.find((m) => m.role === "user")?.content
        const tabName = title || (firstUser ? parseMessageContent(firstUser).text : "") || channelId
        const nextTab: TabInfo = {
          key: sessionKey,
          name: truncName(tabName),
          agentId: resolvedAgentId,
          teamName: team?.name,
          teamColor: team?.color,
        }
        setTabs((prev) => {
          if (prev.some((tab) => tab.key === sessionKey)) return prev
          return [...prev, nextTab]
        })
        setActiveKey(sessionKey)
        activeKeyRef.current = sessionKey

        // Pre-populate messages
        const loaded = mapHistoryToDisplayMessages(history)
        msgs.current.set(sessionKey, loaded)
        bump()
      } finally {
        resumingKeys.current.delete(sessionKey)
      }
    },
    [rpc, bump],
  )

  const closeTab = useCallback(
    (key: string) => {
      setTabs((prev) => {
        const next = prev.filter((t) => t.key !== key)

        if (next.length > 0 && key === activeKeyRef.current) {
          const idx = prev.findIndex((t) => t.key === key)
          const newIdx = Math.min(idx, next.length - 1)
          const newKey = next[newIdx].key
          setActiveKey(newKey)
          activeKeyRef.current = newKey
        }

        if (next.length === 0) {
          setActiveKey("")
          activeKeyRef.current = ""
        }

        msgs.current.delete(key)
        streams.current.delete(key)
        awaitingReplies.current.delete(key)
        tabKeysRef.current.delete(key)
        loadedKeys.current.delete(key)
        resumingKeys.current.delete(key)
        clearEmptyHistoryRetry(key)
        return next
      })
      bump()
    },
    [bump, clearEmptyHistoryRetry],
  )

  const closeAllTabs = useCallback(() => {
    for (const key of tabKeysRef.current) {
      msgs.current.delete(key)
      streams.current.delete(key)
      resumingKeys.current.delete(key)
      clearEmptyHistoryRetry(key)
    }
    awaitingReplies.current.clear()
    tabKeysRef.current.clear()
    loadedKeys.current.clear()
    resumingKeys.current.clear()
    setTabs([])
    setActiveKey("")
    activeKeyRef.current = ""
    bump()
  }, [bump, clearEmptyHistoryRetry])

  const switchTab = useCallback(
    (key: string) => {
      if (key === activeKeyRef.current) return
      setActiveKey(key)
      activeKeyRef.current = key
      void loadSessionMessages(key)
      bump()
    },
    [bump, loadSessionMessages],
  )

  /** Refresh team name + color on all open tabs from the latest team list. */
  const syncTeamMetadata = useCallback(
    (teams: { id: string; name: string; color: string }[]) => {
      const byId = new Map(teams.map((t) => [t.id, t]))
      setTabs((prev) => {
        let changed = false
        const next = prev.map((tab) => {
          // Extract teamId from the session key (format: teamId:channel:channelId)
          const teamId = getTeamIdFromSessionKey(tab.key)
          const team = teamId ? byId.get(teamId) : undefined
          if (!team) return tab
          if (tab.teamName === team.name && tab.teamColor === team.color) return tab
          changed = true
          return { ...tab, teamName: team.name, teamColor: team.color }
        })
        return changed ? next : prev
      })
    },
    [],
  )

  const renameTab = useCallback((key: string, name: string) => {
    setTabs((prev) =>
      prev.map((t) => (t.key === key ? { ...t, name: truncName(name) } : t)),
    )
    // Persist to server
    rpc?.("sessions.rename", { sessionKey: key, title: name }).catch(() => {})
  }, [rpc])

  /* ---- Message operations ---- */

  const addUserMessage = useCallback(
    (key: string, content: string, images?: string[]) => {
      const isFirst = (msgs.current.get(key) ?? []).every(
        (m) => m.role !== "user",
      )
      const msg: Message = { id: createClientId(), role: "user" as const, content }
      if (images?.length) msg.images = images
      mutate(key, (prev) => [...prev, msg])
      if (isFirst) {
        setTabs((prev) =>
          prev.map((t) =>
            t.key === key && t.name === DEFAULT_NAME
              ? { ...t, name: truncName(content) }
              : t,
          ),
        )
      }
    },
    [mutate],
  )

  const addSystemMessage = useCallback(
    (key: string, content: string) => {
      mutate(key, (prev) => [
        ...prev,
        { id: createClientId(), role: "system" as const, content },
      ])
    },
    [mutate],
  )

  const clearMessages = useCallback(
    (key: string) => {
      msgs.current.set(key, [])
      streams.current.delete(key)
      awaitingReplies.current.delete(key)
      clearEmptyHistoryRetry(key)
      // Reset tab name so auto-rename kicks in on next user message
      setTabs((prev) =>
        prev.map((t) => (t.key === key ? { ...t, name: DEFAULT_NAME } : t)),
      )
      if (key === activeKeyRef.current) bump()
    },
    [bump, clearEmptyHistoryRetry],
  )

  const isSessionRunning = useCallback((sessionKey: string): boolean => {
    if (!sessionKey) return false
    if (streams.current.has(sessionKey)) return true
    return (awaitingReplies.current.get(sessionKey) ?? 0) > 0
  }, [])

  return {
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
  }
}
