import { createContext, useContext, useState, useCallback, useEffect, useRef, useMemo, type ReactNode } from "react"
import { Outlet } from "react-router"
import { WifiOffIcon } from "lucide-react"
import { useTranslation } from "react-i18next"
import { useGatewayContext } from "@/contexts/gateway-context"
import type { TeamConfig, SaveState, PromptTemplate, GlobalModelConfig } from "./types"
import {
  isUserTeam,
  cleanTeamForPersist,
  SAVE_FEEDBACK_DURATION_MS,
  DEFAULT_GLOBAL_MODEL_CONFIG,
  extractGlobalModelConfig,
} from "./types"

/* ------------------------------------------------------------------ */
/*  Context                                                            */
/* ------------------------------------------------------------------ */

interface TeamsContextValue {
  teams: TeamConfig[]
  promptTemplates: PromptTemplate[]
  globalModelConfig: GlobalModelConfig
  loading: boolean
  saveState: SaveState
  error: string | null
  /** Save a single team (create or update). Returns true on success. */
  saveTeam: (team: TeamConfig) => Promise<boolean>
  /** Delete a team by id. Returns true on success. */
  deleteTeam: (id: string) => Promise<boolean>
}

const TeamsContext = createContext<TeamsContextValue | null>(null)

export function useTeamsContext(): TeamsContextValue {
  return useContext(TeamsContext) as TeamsContextValue
}

/* ------------------------------------------------------------------ */
/*  Provider                                                           */
/* ------------------------------------------------------------------ */

interface TeamsProviderProps {
  children: ReactNode
}

export function TeamsProvider({ children }: TeamsProviderProps) {
  const { rpc, status, onTeamEvent, onPromptTemplateEvent } = useGatewayContext()
  const [teams, setTeams] = useState<TeamConfig[]>([])
  const [promptTemplates, setPromptTemplates] = useState<PromptTemplate[]>([])
  const [globalModelConfig, setGlobalModelConfig] = useState<GlobalModelConfig>(DEFAULT_GLOBAL_MODEL_CONFIG)
  const [loading, setLoading] = useState(true)
  const [saveState, setSaveState] = useState<SaveState>("idle")
  const [error, setError] = useState<string | null>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>(null)

  // Cleanup save feedback timer on unmount
  useEffect(() => () => clearTimeout(saveTimerRef.current ?? undefined), [])

  // Reusable fetch that refreshes the team list from the backend
  const fetchTeams = useCallback(() => {
    if (status !== "connected") return
    rpc("teams.configs")
      .then((result) => {
        const raw = (result as { teams?: TeamConfig[] })?.teams
        if (Array.isArray(raw)) {
          setTeams(raw.filter(isUserTeam))
        }
        setError(null)
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to load teams")
      })
  }, [rpc, status])

  // Fetch prompt templates
  const fetchTemplates = useCallback(() => {
    if (status !== "connected") return
    rpc("promptTemplates.list")
      .then((result) => {
        const raw = (result as { promptTemplates?: PromptTemplate[] })?.promptTemplates
        if (Array.isArray(raw)) setPromptTemplates(raw)
      })
      .catch(() => {})
  }, [rpc, status])

  // Initial fetch on connect (with cancellation guard)
  useEffect(() => {
    if (status !== "connected") return
    let cancelled = false
    setLoading(true)

    Promise.all([
      rpc("teams.configs"),
      rpc("promptTemplates.list"),
      rpc("config.get").catch(() => ({ config: DEFAULT_GLOBAL_MODEL_CONFIG })),
    ])
      .then(([teamsResult, templatesResult, configResult]) => {
        if (cancelled) return
        const rawTeams = (teamsResult as { teams?: TeamConfig[] })?.teams
        if (Array.isArray(rawTeams)) {
          setTeams(rawTeams.filter(isUserTeam))
        }
        const rawTemplates = (templatesResult as { promptTemplates?: PromptTemplate[] })?.promptTemplates
        if (Array.isArray(rawTemplates)) {
          setPromptTemplates(rawTemplates)
        }
        const rawConfig = (configResult as { config?: Record<string, unknown> })?.config
        setGlobalModelConfig(extractGlobalModelConfig(rawConfig))
        setError(null)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : "Failed to load teams")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => { cancelled = true }
  }, [rpc, status])

  // Auto-refresh when a teamChange event arrives (e.g. from another tab)
  useEffect(() => {
    return onTeamEvent(() => fetchTeams())
  }, [onTeamEvent, fetchTeams])

  // Auto-refresh templates when a promptTemplateChange event arrives
  useEffect(() => {
    return onPromptTemplateEvent(() => fetchTemplates())
  }, [onPromptTemplateEvent, fetchTemplates])

  /** Apply updated teams list from RPC response and show save feedback. */
  const applyResult = useCallback((result: unknown) => {
    const raw = (result as { teams?: TeamConfig[] })?.teams
    if (Array.isArray(raw)) {
      setTeams(raw.filter(isUserTeam))
    }
    setSaveState("saved")
    clearTimeout(saveTimerRef.current ?? undefined)
    saveTimerRef.current = setTimeout(() => setSaveState("idle"), SAVE_FEEDBACK_DURATION_MS)
  }, [])

  const saveTeam = useCallback(async (team: TeamConfig): Promise<boolean> => {
    setSaveState("saving")
    setError(null)
    try {
      const result = await rpc("teams.save", { team: cleanTeamForPersist(team) })
      applyResult(result)
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed")
      setSaveState("error")
      return false
    }
  }, [rpc, applyResult])

  const deleteTeam = useCallback(async (id: string): Promise<boolean> => {
    setSaveState("saving")
    setError(null)
    try {
      const result = await rpc("teams.delete", { id })
      applyResult(result)
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed")
      setSaveState("error")
      return false
    }
  }, [rpc, applyResult])

  const contextValue = useMemo<TeamsContextValue>(
    () => ({ teams, promptTemplates, globalModelConfig, loading, saveState, error, saveTeam, deleteTeam }),
    [teams, promptTemplates, globalModelConfig, loading, saveState, error, saveTeam, deleteTeam],
  )

  return (
    <TeamsContext.Provider value={contextValue}>
      {children}
    </TeamsContext.Provider>
  )
}

/* ------------------------------------------------------------------ */
/*  Layout component                                                   */
/* ------------------------------------------------------------------ */

export function TeamsLayout() {
  const { t } = useTranslation()
  const { status } = useGatewayContext()

  if (status !== "connected") {
    return (
      <div data-slot="teams-layout" className="flex h-full items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <WifiOffIcon className="size-8" />
          <p className="text-sm">
            {status === "connecting" ? t("common.connecting") : t("common.disconnected")}
          </p>
        </div>
      </div>
    )
  }

  return <Outlet />
}
