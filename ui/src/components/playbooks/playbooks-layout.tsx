import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react"
import { Outlet } from "react-router"
import { WifiOffIcon } from "lucide-react"
import { useTranslation } from "react-i18next"
import { useGatewayContext } from "@/contexts/gateway-context"
import type { PlaybookCreateInput, PlaybookSummary, PlaybookUpdateInput, SaveState } from "./types"
import { SAVE_FEEDBACK_DURATION_MS } from "./types"

interface PlaybooksContextValue {
  playbooks: PlaybookSummary[]
  loading: boolean
  saveState: SaveState
  error: string | null
  refreshPlaybooks: () => Promise<void>
  createPlaybook: (input: PlaybookCreateInput) => Promise<boolean>
  updatePlaybook: (input: PlaybookUpdateInput) => Promise<boolean>
  renamePlaybook: (name: string, newName: string) => Promise<boolean>
  deletePlaybook: (name: string) => Promise<boolean>
}

const PlaybooksContext = createContext<PlaybooksContextValue | null>(null)

export function usePlaybooksContext(): PlaybooksContextValue {
  const ctx = useContext(PlaybooksContext)
  if (!ctx) throw new Error("usePlaybooksContext must be used within PlaybooksLayout")
  return ctx
}

export function PlaybooksLayout() {
  const { t } = useTranslation()
  const { rpc, status, onPlaybookEvent } = useGatewayContext()
  const [playbooks, setPlaybooks] = useState<PlaybookSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [saveState, setSaveState] = useState<SaveState>("idle")
  const [error, setError] = useState<string | null>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>(null)

  useEffect(() => () => clearTimeout(saveTimerRef.current ?? undefined), [])

  const refreshPlaybooks = useCallback(async () => {
    try {
      const result = await rpc("playbooks.list")
      const raw = (result as { playbooks?: PlaybookSummary[] })?.playbooks
      if (Array.isArray(raw)) setPlaybooks(raw)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load playbooks")
    }
  }, [rpc])

  useEffect(() => {
    if (status !== "connected") return
    let cancelled = false
    setLoading(true)

    refreshPlaybooks().finally(() => {
      if (!cancelled) setLoading(false)
    })

    return () => { cancelled = true }
  }, [refreshPlaybooks, status])

  useEffect(() => {
    return onPlaybookEvent(() => {
      void refreshPlaybooks()
    })
  }, [onPlaybookEvent, refreshPlaybooks])

  const markSaved = useCallback(() => {
    setSaveState("saved")
    clearTimeout(saveTimerRef.current ?? undefined)
    saveTimerRef.current = setTimeout(() => setSaveState("idle"), SAVE_FEEDBACK_DURATION_MS)
  }, [])

  const createPlaybook = useCallback(async (input: PlaybookCreateInput): Promise<boolean> => {
    setSaveState("saving")
    setError(null)
    try {
      await rpc("playbooks.create", { ...input })
      markSaved()
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : "Create failed")
      setSaveState("error")
      return false
    }
  }, [markSaved, rpc])

  const updatePlaybook = useCallback(async (input: PlaybookUpdateInput): Promise<boolean> => {
    setSaveState("saving")
    setError(null)
    try {
      await rpc("playbooks.update", { ...input })
      markSaved()
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed")
      setSaveState("error")
      return false
    }
  }, [markSaved, rpc])

  const renamePlaybook = useCallback(async (name: string, newName: string): Promise<boolean> => {
    setSaveState("saving")
    setError(null)
    try {
      await rpc("playbooks.rename", { name, newName })
      markSaved()
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : "Rename failed")
      setSaveState("error")
      return false
    }
  }, [markSaved, rpc])

  const deletePlaybook = useCallback(async (name: string): Promise<boolean> => {
    setSaveState("saving")
    setError(null)
    try {
      await rpc("playbooks.delete", { name })
      markSaved()
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed")
      setSaveState("error")
      return false
    }
  }, [markSaved, rpc])

  const contextValue = useMemo<PlaybooksContextValue>(
    () => ({
      playbooks,
      loading,
      saveState,
      error,
      refreshPlaybooks,
      createPlaybook,
      updatePlaybook,
      renamePlaybook,
      deletePlaybook,
    }),
    [playbooks, loading, saveState, error, refreshPlaybooks, createPlaybook, updatePlaybook, renamePlaybook, deletePlaybook],
  )

  if (status !== "connected") {
    return (
      <div data-slot="playbooks-layout" className="flex h-full items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <WifiOffIcon className="size-8" />
          <p className="text-sm">
            {status === "connecting" ? t("common.connecting") : t("common.disconnected")}
          </p>
        </div>
      </div>
    )
  }

  return (
    <PlaybooksContext.Provider value={contextValue}>
      <Outlet />
    </PlaybooksContext.Provider>
  )
}
