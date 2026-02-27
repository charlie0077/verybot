import { useState, useEffect, useCallback, useRef, useMemo } from "react"
import { useMediaQuery } from "usehooks-ts"
import { useTranslation } from "react-i18next"
import { useLocation, useNavigate } from "react-router"
import {
  DndContext,
  DragOverlay,
  closestCorners,
  pointerWithin,
  useSensor,
  useSensors,
  PointerSensor,
  type CollisionDetection,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
} from "@dnd-kit/core"
import { arrayMove } from "@dnd-kit/sortable"
import {
  PlusIcon,
  ArchiveIcon,
  LoaderIcon,
  AlertCircleIcon,
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
import { TaskCardOverlay } from "./task-card"
import { AddTaskModal } from "./add-task-modal"
import { KanbanColumn } from "./kanban-column"
import {
  DRAG_ACTIVATION_DISTANCE,
  DEFAULT_TASK_STATUSES,
  buildStatusColumns,
  type Priority,
  type Task,
  type TaskAttachment,
  type TaskStatus,
  type TeamConfig,
  type StatusColumnConfig,
} from "./types"
import { buildTaskContextMessage } from "./task-context-message"
import {
  buildTaskSessionMap,
  getSubscribedWorkerIds,
  getTaskMapKey,
  type SessionListEntry,
} from "./task-runtime"
import {
  buildArchivedTasksPath,
  buildTaskDetailPathFromTask,
} from "./task-routes"
import { cn, createClientId } from "@/lib/utils"

/* ------------------------------------------------------------------ */
/*  Main Page                                                          */
/* ------------------------------------------------------------------ */

const DEFAULT_TEAM_ID = "default"
const TEAM_QUERY_PARAM = "teamId"
const DEFAULT_DONE_STATUS = "done"
const OVER_RECT_MIDPOINT_DIVISOR = 2
const MOBILE_BREAKPOINT_QUERY = "(min-width: 768px)"

export function TasksPage() {
  const { t } = useTranslation()
  const location = useLocation()
  const navigate = useNavigate()
  const isDesktop = useMediaQuery(MOBILE_BREAKPOINT_QUERY)
  const { rpc, status, onTaskEvent } = useGatewayContext()
  const [tasks, setTasks] = useState<Task[]>([])
  const [teams, setTeams] = useState<TeamConfig[]>([])
  const [addModalStatus, setAddModalStatus] = useState<TaskStatus | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [latestTaskSessionByKey, setLatestTaskSessionByKey] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const mountedRef = useRef(true)

  // DnD state
  const [activeId, setActiveId] = useState<string | null>(null)
  const [overColumnKey, setOverColumnKey] = useState<TaskStatus | null>(null)
  const dragOriginColumn = useRef<TaskStatus | null>(null)
  const lastHoveredTask = useRef<{ column: TaskStatus; taskId: string; insertAfter: boolean } | null>(null)
  const suppressRefetch = useRef(false)
  const pendingRefetch = useRef(false)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: DRAG_ACTIVATION_DISTANCE } }),
  )

  const selectedTeamId = useMemo(
    () => new URLSearchParams(location.search).get("teamId")?.trim() ?? "",
    [location.search],
  )

  // Auto-select first team if none selected or selected team not found
  const actualTeamId = useMemo(() => {
    if (teams.length === 0) return selectedTeamId || ""
    if (selectedTeamId && teams.some((team) => team.id === selectedTeamId)) return selectedTeamId
    return teams[0]?.id ?? ""
  }, [selectedTeamId, teams])

  // Navigate to auto-selected team if needed
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
  }, [teams, selectedTeamId, navigate, location.search])

  const selectedTeam = useMemo(
    () => teams.find((team) => team.id === actualTeamId),
    [teams, actualTeamId],
  )
  const doneStatusKey: TaskStatus = DEFAULT_DONE_STATUS

  // Build dynamic status columns from team config
  const statusColumns: StatusColumnConfig[] = useMemo(
    () => buildStatusColumns(selectedTeam?.statuses ?? DEFAULT_TASK_STATUSES),
    [selectedTeam],
  )

  const statusColumnKeys = useMemo(
    () => new Set(statusColumns.map((c) => c.key)),
    [statusColumns],
  )

  /**
   * Prefer pointer-based collisions so empty columns are easy to target.
   * Fall back to corner matching when pointer collisions are unavailable.
   */
  const collisionDetection = useCallback<CollisionDetection>((args) => {
    const pointerCollisions = pointerWithin(args)
    if (pointerCollisions.length > 0) return pointerCollisions
    return closestCorners(args)
  }, [])

  // ---------- data fetching ----------

  const fetchTasks = useCallback(async () => {
    try {
      const filter: Record<string, unknown> = {}
      if (actualTeamId) filter.teamId = actualTeamId
      const [taskResult, sessionResult] = await Promise.all([
        rpc("tasks.list", filter) as Promise<{ tasks: Task[] }>,
        (rpc("sessions.list") as Promise<{ sessions?: SessionListEntry[] }>)
          .catch(() => ({ sessions: [] })),
      ])
      if (mountedRef.current) {
        setTasks(taskResult.tasks)
        const sessions = Array.isArray(sessionResult.sessions) ? sessionResult.sessions : []
        setLatestTaskSessionByKey(buildTaskSessionMap(sessions))
        setError(null)
      }
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : "Failed to load tasks")
      }
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
    fetchTasks()
  }, [status, fetchTasks])

  useEffect(() => {
    if (status !== "connected") return
    rpc("chat.teams").then((result) => {
      const list = (result as { teams: TeamConfig[] }).teams ?? []
      setTeams(list)
    }).catch(() => {})
  }, [rpc, status])

  useEffect(() => {
    return onTaskEvent(() => {
      if (suppressRefetch.current) {
        pendingRefetch.current = true
        return
      }
      void fetchTasks()
    })
  }, [onTaskEvent, fetchTasks])

  // ---------- grouped tasks ----------

  const grouped: Record<string, Task[]> = useMemo(() => {
    const result: Record<string, Task[]> = {}
    for (const col of statusColumns) {
      result[col.key] = []
    }
    for (const task of tasks) {
      if (task.status in result) {
        result[task.status].push(task)
      }
    }
    return result
  }, [tasks, statusColumns])

  const teamNamesById = useMemo(
    () => Object.fromEntries(teams.map((team) => [team.id, team.name || team.id])),
    [teams],
  )

  const agentNamesById = useMemo(() => {
    const map: Record<string, string> = {}
    for (const team of teams) {
      if (team.orchestrator?.id) map[team.orchestrator.id] = team.orchestrator.name
      for (const w of team.workers ?? []) {
        if (w.id) map[w.id] = w.name
      }
    }
    return map
  }, [teams])

  const activeTask = activeId ? tasks.find((t) => t.id === activeId) ?? null : null
  const subscribedWorkerIdsByTaskKey = useMemo(() => {
    const map: Record<string, string[]> = {}
    for (const task of tasks) {
      map[getTaskMapKey(task)] = getSubscribedWorkerIds(task, teams)
    }
    return map
  }, [tasks, teams])

  // ---------- helpers ----------

  /** Find which status column a task id belongs to. */
  function findColumn(taskId: string): TaskStatus | null {
    for (const col of statusColumns) {
      if (grouped[col.key]?.some((t) => t.id === taskId)) return col.key
    }
    return null
  }

  /** Persist the ordering of a column to the backend. */
  function persistColumnOrder(columnStatus: TaskStatus, columnTasks: Task[]) {
    const orderedIds = columnTasks.map((t) => t.id)
    return rpc("tasks.reorder", { status: columnStatus, orderedIds })
  }

  // ---------- DnD handlers ----------

  function handleDragStart(event: DragStartEvent) {
    const id = event.active.id as string
    setActiveId(id)
    dragOriginColumn.current = findColumn(id)
    suppressRefetch.current = true
    pendingRefetch.current = false
    lastHoveredTask.current = null
  }

  function handleDragOver(event: DragOverEvent) {
    const { active, over } = event
    if (!over) { setOverColumnKey(null); return }

    const overId = over.id as string
    const overData = over.data?.current as { status?: TaskStatus } | undefined
    let targetColumn: TaskStatus | null = overData?.status ?? null

    if (!targetColumn && statusColumnKeys.has(overId)) {
      targetColumn = overId as TaskStatus
    }
    if (!targetColumn) {
      targetColumn = findColumn(overId)
    }

    setOverColumnKey(targetColumn)

    if (!targetColumn) return
    if (lastHoveredTask.current?.column !== targetColumn) {
      lastHoveredTask.current = null
    }
    if (!statusColumnKeys.has(overId)) {
      const overMidpoint = over.rect.top + over.rect.height / OVER_RECT_MIDPOINT_DIVISOR
      const translatedTop = active.rect.current.translated?.top
      const insertAfter = translatedTop !== undefined && translatedTop > overMidpoint
      lastHoveredTask.current = { column: targetColumn, taskId: overId, insertAfter }
    }

    const activeStatus = findColumn(active.id as string)
    if (!activeStatus || activeStatus === targetColumn) return

    setTasks((prev) => {
      const task = prev.find((t) => t.id === active.id)
      if (!task) return prev
      return prev.map((t) =>
        t.id === active.id ? { ...t, status: targetColumn } : t,
      )
    })
  }

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    const originColumn = dragOriginColumn.current
    setActiveId(null)
    setOverColumnKey(null)
    dragOriginColumn.current = null

    if (!over || !originColumn) {
      suppressRefetch.current = false
      lastHoveredTask.current = null
      return
    }

    try {
      const overId = over.id as string
      const overData = over.data?.current as { status?: TaskStatus } | undefined
      let targetColumn: TaskStatus | null = overData?.status ?? null
      if (!targetColumn && statusColumnKeys.has(overId)) {
        targetColumn = overId as TaskStatus
      }
      if (!targetColumn) targetColumn = findColumn(overId)
      if (!targetColumn) targetColumn = originColumn

      if (originColumn !== targetColumn) {
        const activeId = active.id as string
        const columnTasks = tasks.filter((t) => t.status === targetColumn)
        const withoutActive = columnTasks.filter((t) => t.id !== activeId)
        const isColumnDrop = statusColumnKeys.has(overId)
        const computeDropIndexFor = (referenceId?: string, insertAfter = false) => {
          if (!referenceId) return withoutActive.length
          const referenceIdx = columnTasks.findIndex((t) => t.id === referenceId)
          if (referenceIdx === -1) return withoutActive.length
          const activeIdx = columnTasks.findIndex((t) => t.id === activeId)
          const shift = activeIdx !== -1 && activeIdx < referenceIdx ? 1 : 0
          const adjustedIdx = referenceIdx - shift + (insertAfter ? 1 : 0)
          return Math.min(Math.max(adjustedIdx, 0), withoutActive.length)
        }

        let dropIndex: number
        if (isColumnDrop) {
          const hint = lastHoveredTask.current?.column === targetColumn ? lastHoveredTask.current : null
          dropIndex = computeDropIndexFor(hint?.taskId, hint?.insertAfter ?? false)
        } else {
          const overMidpoint = over.rect.top + over.rect.height / OVER_RECT_MIDPOINT_DIVISOR
          const translatedTop = active.rect.current.translated?.top
          const insertAfter = translatedTop !== undefined && translatedTop > overMidpoint
          dropIndex = computeDropIndexFor(overId, insertAfter)
        }

        const draggedTask = columnTasks.find((t) => t.id === activeId)
          ?? tasks.find((t) => t.id === activeId)
        const reordered = [...withoutActive]
        if (draggedTask) {
          reordered.splice(dropIndex, 0, { ...draggedTask, status: targetColumn })
        }

        setTasks((prev) => {
          const others = prev.filter((t) => t.status !== targetColumn)
          return [...others, ...reordered]
        })

        try {
          await rpc("tasks.update", { id: active.id as string, status: targetColumn })
          await persistColumnOrder(targetColumn, reordered)
        } catch (err) {
          setError(err instanceof Error ? err.message : "Failed to move task")
        } finally {
          fetchTasks()
        }
      } else {
        const columnTasks = tasks.filter((t) => t.status === targetColumn)
        const oldIndex = columnTasks.findIndex((t) => t.id === active.id)
        const overIndex = columnTasks.findIndex((t) => t.id === overId)

        if (oldIndex !== -1 && overIndex !== -1 && oldIndex !== overIndex) {
          const reordered = arrayMove(columnTasks, oldIndex, overIndex)
          setTasks((prev) => {
            const others = prev.filter((t) => t.status !== targetColumn)
            return [...others, ...reordered]
          })
          persistColumnOrder(targetColumn, reordered).catch((err: unknown) => {
            setError(err instanceof Error ? err.message : "Failed to reorder")
            fetchTasks()
          })
        }
      }
    } finally {
      suppressRefetch.current = false
      lastHoveredTask.current = null
      if (pendingRefetch.current) {
        pendingRefetch.current = false
        void fetchTasks()
      }
    }
  }

  // ---------- CRUD handlers ----------

  async function handleCreate(input: { title: string; description?: string; teamId?: string; priority: Priority; status: TaskStatus; attachments?: TaskAttachment[] }) {
    try {
      await rpc("tasks.create", input)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create task")
    }
  }

  function handleOpenEdit(task: Task) {
    void navigate(buildTaskDetailPathFromTask(task))
  }

  function handleOpenArchivedView() {
    const teamIdForPath = selectedTeamId || actualTeamId || null
    void navigate(buildArchivedTasksPath(teamIdForPath))
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

  function handleWorkOn(task: Task) {
    const message = buildTaskContextMessage(task)
    const teamId = task.teamId || teams[0]?.id
    if (!teamId) return
    const params = new URLSearchParams()
    if (teamId !== DEFAULT_TEAM_ID) {
      params.set(TEAM_QUERY_PARAM, teamId)
    }
    const chatPath = params.size > 0 ? `/chat?${params.toString()}` : "/chat"
    void navigate(chatPath, {
      state: {
        pendingStartSession: {
          requestId: createClientId(),
          teamId,
          message,
        },
      },
    })
  }

  function handleOpenLatestTaskSession(task: Task) {
    const sessionKey = latestTaskSessionByKey[getTaskMapKey(task)]
    if (!sessionKey) return
    void navigate(`/sessions?sessionKey=${encodeURIComponent(sessionKey)}`)
  }

  async function handleClearDone() {
    try {
      await rpc("tasks.archiveDone", { teamId: actualTeamId || undefined })
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to archive tasks")
    }
  }

  // ---------- render ----------

  if (status !== "connected") {
    return (
      <div data-slot="tasks-page" className="flex h-full items-center justify-center">
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
    <div data-slot="tasks-page" className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2 sm:px-4 md:px-6">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <h1 className="text-lg font-semibold text-foreground">{t("tasks.title")}</h1>
          {loading && <LoaderIcon className="size-4 animate-spin text-muted-foreground" />}
          {error && (
            <span className="flex min-w-0 items-center gap-1 text-sm text-destructive">
              <AlertCircleIcon className="size-3.5" />
              <span className="truncate">{error}</span>
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2 sm:gap-3">
          <Button
            size="sm"
            variant="outline"
            onClick={handleOpenArchivedView}
          >
            <ArchiveIcon className="mr-1.5 size-3.5" />
            {t("tasks.showArchived")}
          </Button>
          <Button
            size="sm"
            onClick={() => setAddModalStatus(statusColumns[0]?.key ?? "todo")}
          >
            <PlusIcon className="mr-1.5 size-3.5" />
            {t("tasks.addTask")}
          </Button>
        </div>
      </div>

      {/* Kanban board with DnD */}
      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
      >
        <div
          className={cn(
            "flex min-h-0 flex-1 pt-1",
            isDesktop
              ? "gap-0 overflow-auto px-1 pb-1"
              : "scrollbar-hidden snap-x snap-mandatory touch-pan-x flex-row items-stretch gap-3 overflow-x-auto overflow-y-hidden px-3 pb-4 sm:px-4",
          )}
        >
          {statusColumns.map((col) => (
            <KanbanColumn
              key={col.key}
              statusKey={col.key}
              label={col.label}
              color={col.color}
              tasks={grouped[col.key] ?? []}
              teamNamesById={teamNamesById}
              agentNamesById={agentNamesById}
              getSubscribedWorkerIds={(task) => subscribedWorkerIdsByTaskKey[getTaskMapKey(task)] ?? []}
              getLatestSessionKey={(task) => latestTaskSessionByKey[getTaskMapKey(task)]}
              isOver={overColumnKey === col.key}
              onDelete={setDeleteTarget}
              onEdit={handleOpenEdit}
              onWorkOn={handleWorkOn}
              onOpenLatestSession={handleOpenLatestTaskSession}
              onAdd={() => setAddModalStatus(col.key)}
              onClearDone={col.key === doneStatusKey ? handleClearDone : undefined}
              compact={!isDesktop}
            />
          ))}
        </div>

        <DragOverlay dropAnimation={null}>
          {activeTask ? <TaskCardOverlay task={activeTask} teamName={teamNamesById[activeTask.teamId]} agentNamesById={agentNamesById} /> : null}
        </DragOverlay>
      </DndContext>

      {/* Add task modal */}
      <AddTaskModal
        open={addModalStatus !== null}
        onOpenChange={(open) => { if (!open) setAddModalStatus(null) }}
        teamId={actualTeamId || null}
        teams={teams}
        statusColumns={statusColumns}
        initialStatus={addModalStatus ?? statusColumns[0]?.key ?? "todo"}
        onSave={handleCreate}
      />

      {/* Delete confirmation */}
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
