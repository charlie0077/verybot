import { createContext, useContext, useState, useCallback, useEffect, useRef, useMemo } from "react"
import { Outlet } from "react-router"
import { WifiOffIcon } from "lucide-react"
import { useTranslation } from "react-i18next"
import { useGatewayContext } from "@/contexts/gateway-context"
import type { PromptTemplate, SaveState } from "@/components/teams/types"
import { SAVE_FEEDBACK_DURATION_MS } from "@/components/teams/types"

/* ------------------------------------------------------------------ */
/*  Context                                                            */
/* ------------------------------------------------------------------ */

interface PromptTemplatesContextValue {
  templates: PromptTemplate[]
  loading: boolean
  saveState: SaveState
  error: string | null
  /** Save a template (create or update). Omit id for new templates. */
  saveTemplate: (template: Omit<PromptTemplate, "id" | "createdAt" | "updatedAt" | "builtin"> & { id?: string }) => Promise<boolean>
  /** Fork a template by id. Returns the forked template on success. */
  forkTemplate: (id: string, input?: { name?: string; description?: string }) => Promise<PromptTemplate | null>
  /** Delete a template by id. Returns true on success. */
  deleteTemplate: (id: string) => Promise<boolean>
}

const PromptTemplatesContext = createContext<PromptTemplatesContextValue | null>(null)

export function usePromptTemplatesContext(): PromptTemplatesContextValue {
  const ctx = useContext(PromptTemplatesContext)
  if (!ctx) throw new Error("usePromptTemplatesContext must be used within PromptTemplatesLayout")
  return ctx
}

/* ------------------------------------------------------------------ */
/*  Layout component                                                   */
/* ------------------------------------------------------------------ */

export function PromptTemplatesLayout() {
  const { t } = useTranslation()
  const { rpc, status, onPromptTemplateEvent } = useGatewayContext()
  const [templates, setTemplates] = useState<PromptTemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [saveState, setSaveState] = useState<SaveState>("idle")
  const [error, setError] = useState<string | null>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>(null)

  // Cleanup save feedback timer on unmount
  useEffect(() => () => clearTimeout(saveTimerRef.current ?? undefined), [])

  // Fetch templates list
  const fetchTemplates = useCallback(async () => {
    try {
      const result = await rpc("promptTemplates.list")
      const raw = (result as { promptTemplates?: PromptTemplate[] })?.promptTemplates
      if (Array.isArray(raw)) setTemplates(raw)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load templates")
    }
  }, [rpc])

  // Initial fetch
  useEffect(() => {
    if (status !== "connected") return
    let cancelled = false
    setLoading(true)

    fetchTemplates().finally(() => {
      if (!cancelled) setLoading(false)
    })

    return () => { cancelled = true }
  }, [fetchTemplates, status])

  // Re-fetch on promptTemplate change events
  useEffect(() => {
    return onPromptTemplateEvent(() => {
      void fetchTemplates()
    })
  }, [onPromptTemplateEvent, fetchTemplates])

  const saveTemplate = useCallback(async (
    template: Omit<PromptTemplate, "id" | "createdAt" | "updatedAt" | "builtin"> & { id?: string },
  ): Promise<boolean> => {
    setSaveState("saving")
    setError(null)
    try {
      if (template.id) {
        await rpc("promptTemplates.update", template)
      } else {
        await rpc("promptTemplates.create", template)
      }
      setSaveState("saved")
      clearTimeout(saveTimerRef.current ?? undefined)
      saveTimerRef.current = setTimeout(() => setSaveState("idle"), SAVE_FEEDBACK_DURATION_MS)
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed")
      setSaveState("error")
      return false
    }
  }, [rpc])

  const deleteTemplate = useCallback(async (id: string): Promise<boolean> => {
    setSaveState("saving")
    setError(null)
    try {
      await rpc("promptTemplates.delete", { id })
      setSaveState("saved")
      clearTimeout(saveTimerRef.current ?? undefined)
      saveTimerRef.current = setTimeout(() => setSaveState("idle"), SAVE_FEEDBACK_DURATION_MS)
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed")
      setSaveState("error")
      return false
    }
  }, [rpc])

  const forkTemplate = useCallback(async (
    id: string,
    input: { name?: string; description?: string } = {},
  ): Promise<PromptTemplate | null> => {
    setSaveState("saving")
    setError(null)
    try {
      const result = await rpc("promptTemplates.fork", {
        id,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
      })
      const promptTemplate = (result as { promptTemplate?: PromptTemplate })?.promptTemplate
      if (!promptTemplate) throw new Error("Fork failed")
      setSaveState("saved")
      clearTimeout(saveTimerRef.current ?? undefined)
      saveTimerRef.current = setTimeout(() => setSaveState("idle"), SAVE_FEEDBACK_DURATION_MS)
      return promptTemplate
    } catch (err) {
      setError(err instanceof Error ? err.message : "Fork failed")
      setSaveState("error")
      return null
    }
  }, [rpc])

  const contextValue = useMemo<PromptTemplatesContextValue>(
    () => ({ templates, loading, saveState, error, saveTemplate, forkTemplate, deleteTemplate }),
    [templates, loading, saveState, error, saveTemplate, forkTemplate, deleteTemplate],
  )

  if (status !== "connected") {
    return (
      <div data-slot="prompt-templates-layout" className="flex h-full items-center justify-center">
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
    <PromptTemplatesContext.Provider value={contextValue}>
      <Outlet />
    </PromptTemplatesContext.Provider>
  )
}
