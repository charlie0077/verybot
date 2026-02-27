import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { useLocation, useNavigate } from "react-router"
import {
  AlertCircleIcon,
  ArchiveIcon,
  LoaderIcon,
  WifiOffIcon,
} from "lucide-react"
import { useGatewayContext } from "@/contexts/gateway-context"
import { Button } from "@/components/ui/button"
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
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import type { Task, TeamConfig } from "./types"
import { formatTaskLabel } from "./task-label"
import { buildTaskDetailPathFromTask, buildTasksListPath } from "./task-routes"

const TEAM_QUERY_PARAM = "teamId"
const ARCHIVED_STATUS_KEY = "archived"

export function ArchivedTasksPage() {
  const { t } = useTranslation()
  const location = useLocation()
  const navigate = useNavigate()
  const { rpc, status, onTaskEvent } = useGatewayContext()
  const [tasks, setTasks] = useState<Task[]>([])
  const [teams, setTeams] = useState<TeamConfig[]>([])
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const mountedRef = useRef(true)

  const selectedTeamId = useMemo(
    () => new URLSearchParams(location.search).get(TEAM_QUERY_PARAM)?.trim() ?? "",
    [location.search],
  )

  const actualTeamId = useMemo(() => {
    if (teams.length === 0) return selectedTeamId || ""
    if (selectedTeamId && teams.some((team) => team.id === selectedTeamId)) return selectedTeamId
    return teams[0]?.id ?? ""
  }, [selectedTeamId, teams])

  useEffect(() => {
    if (teams.length === 0) return
    if (!selectedTeamId || !teams.some((team) => team.id === selectedTeamId)) {
      const firstTeamId = teams[0]?.id
      if (firstTeamId) {
        const params = new URLSearchParams(location.search)
        params.set(TEAM_QUERY_PARAM, firstTeamId)
        void navigate(`?${params.toString()}`, { replace: true })
      }
    }
  }, [teams, selectedTeamId, location.search, navigate])

  const fetchArchivedTasks = useCallback(async () => {
    try {
      const filter: Record<string, unknown> = { status: ARCHIVED_STATUS_KEY }
      if (actualTeamId) filter.teamId = actualTeamId
      const result = await rpc("tasks.list", filter) as { tasks?: Task[] }
      if (!mountedRef.current) return
      setTasks(Array.isArray(result.tasks) ? result.tasks : [])
      setError(null)
    } catch (err) {
      if (!mountedRef.current) return
      setError(err instanceof Error ? err.message : "Failed to load tasks")
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [rpc, actualTeamId])

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  useEffect(() => {
    if (status !== "connected") return
    void fetchArchivedTasks()
  }, [status, fetchArchivedTasks])

  useEffect(() => {
    if (status !== "connected") return
    void rpc("chat.teams")
      .then((result) => {
        const list = (result as { teams: TeamConfig[] }).teams ?? []
        setTeams(list)
      })
      .catch(() => {})
  }, [rpc, status])

  useEffect(() => {
    return onTaskEvent(() => {
      void fetchArchivedTasks()
    })
  }, [onTaskEvent, fetchArchivedTasks])

  const teamNamesById = useMemo(
    () => Object.fromEntries(teams.map((team) => [team.id, team.name || team.id])),
    [teams],
  )

  const sortedTasks = useMemo(
    () => [...tasks].sort((a, b) => b.updatedAt - a.updatedAt),
    [tasks],
  )

  function handleOpenTask(task: Task) {
    void navigate(buildTaskDetailPathFromTask(task, { includeArchived: true }))
  }

  function handleBackToTasks() {
    const teamIdForPath = actualTeamId || selectedTeamId || null
    void navigate(buildTasksListPath(teamIdForPath))
  }

  async function handleDelete() {
    if (!deleteTarget) return
    try {
      await rpc("tasks.delete", { id: deleteTarget })
      setDeleteTarget(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete task")
    }
  }

  if (status !== "connected") {
    return (
      <div data-slot="archived-tasks-page" className="flex h-full items-center justify-center">
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
    <div data-slot="archived-tasks-page" className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-6 py-2">
        <div className="flex items-center gap-3">
          <h1 className="inline-flex items-center gap-2 text-lg font-semibold text-foreground">
            <ArchiveIcon className="size-4" />
            {t("tasks.archived")}
          </h1>
          {loading && <LoaderIcon className="size-4 animate-spin text-muted-foreground" />}
          {error && (
            <span className="flex items-center gap-1 text-sm text-destructive">
              <AlertCircleIcon className="size-3.5" />
              {error}
            </span>
          )}
        </div>
        <Button size="sm" variant="outline" onClick={handleBackToTasks}>
          {t("tasks.backToTasks")}
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        {sortedTasks.length === 0 && !loading ? (
          <p className="py-10 text-center text-sm text-muted-foreground">{t("tasks.noTasks")}</p>
        ) : (
          <div className="flex flex-col gap-3">
            {sortedTasks.map((task) => (
              <Card
                key={task.id}
                size="sm"
                interactive
                onClick={() => handleOpenTask(task)}
                className="gap-2 border-border py-3"
              >
                <CardHeader className="pb-0">
                  <CardTitle className="flex items-center justify-between gap-3 text-sm">
                    <span className="truncate">{formatTaskLabel(task, teamNamesById[task.teamId])}</span>
                    <span className="shrink-0 text-xs font-normal text-muted-foreground">
                      {new Date(task.updatedAt).toLocaleString()}
                    </span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="pt-1">
                  <p className="line-clamp-1 text-sm font-medium text-foreground">{task.title}</p>
                </CardContent>
                <CardFooter className="justify-end gap-2 pt-0">
                  <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); handleOpenTask(task) }}>
                    {t("tasks.editTask")}
                  </Button>
                  <Button size="sm" variant="destructive" onClick={(e) => { e.stopPropagation(); setDeleteTarget(task.id) }}>
                    {t("common.delete")}
                  </Button>
                </CardFooter>
              </Card>
            ))}
          </div>
        )}
      </div>

      <AlertDialog open={deleteTarget !== null} onOpenChange={() => setDeleteTarget(null)}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("tasks.deleteTask")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("tasks.deleteTaskDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={handleDelete}>
              {t("common.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
