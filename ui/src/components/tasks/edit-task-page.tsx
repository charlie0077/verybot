import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react"
import { useTranslation } from "react-i18next"
import { Link, useLocation, useNavigate, useParams } from "react-router"
import { useMediaQuery } from "usehooks-ts"
import {
  AlertCircleIcon,
  ArrowLeftIcon,
  BotIcon,
  ChevronDownIcon,
  LoaderIcon,
  PaperclipIcon,
  SaveIcon,
  SettingsIcon,
  ScrollTextIcon,
  UsersIcon,
  WifiOffIcon,
  XIcon,
} from "lucide-react"
import { useGatewayContext } from "@/contexts/gateway-context"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Switch } from "@/components/ui/switch"
import {
  PRIORITIES,
  PRIORITY_ICONS,
  DEFAULT_TASK_STATUSES,
  buildStatusColumns,
  type Priority,
  type Task,
  type TaskAttachment,
  type TaskComment,
  type TaskStatus,
  type TeamConfig,
} from "./types"
import {
  INLINE_IMAGE_MARKER,
  buildDescriptionWithInlineImages,
  removeInlineImageMarkerByIndex,
  toEditorDescriptionWithInlineMarkers,
} from "./inline-image-markdown"
import {
  isSupportedTaskImageType,
  MAX_TASK_IMAGE_UPLOAD_BYTES,
  taskImageFileToBase64,
} from "./task-image-input"
import {
  TaskDescriptionEditor,
  type TaskDescriptionEditorHandle,
} from "./task-description-editor"
import {
  buildTaskSessionMap,
  getSubscribedWorkerIds,
  getTaskMapKey,
  type SessionListEntry,
} from "./task-runtime"
import { TaskCommentsPanel } from "./task-comments-panel"
import {
  buildArchivedTasksPath,
  buildTasksListPath,
  resolveTaskFromRoute,
  shouldIncludeArchivedFromSearch,
} from "./task-routes"
import { formatTaskLabel } from "./task-label"

const ARCHIVED_STATUS_KEY = "archived"
const DESKTOP_EDIT_TASK_BREAKPOINT_QUERY = "(min-width: 1280px)"

function priorityLabelKey(priority: Priority): "tasks.priorityHigh" | "tasks.priorityMedium" | "tasks.priorityLow" {
  switch (priority) {
    case "high":
      return "tasks.priorityHigh"
    case "low":
      return "tasks.priorityLow"
    default:
      return "tasks.priorityMedium"
  }
}

function resolveInitialTeamId(teamId: string, teams: TeamConfig[]): string {
  if (teamId && teams.some((team) => team.id === teamId)) return teamId
  const defaultTeam = teams.find((team) => team.id === "default")
  return defaultTeam?.id ?? teams[0]?.id ?? teamId
}

export function EditTaskPage() {
  const { t } = useTranslation()
  const { taskId, teamId } = useParams<{ taskId: string; teamId?: string }>()
  const location = useLocation()
  const navigate = useNavigate()
  const isDesktop = useMediaQuery(DESKTOP_EDIT_TASK_BREAKPOINT_QUERY)
  const { rpc, status, onTaskEvent } = useGatewayContext()

  const [task, setTask] = useState<Task | null>(null)
  const [teams, setTeams] = useState<TeamConfig[]>([])
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [statusValue, setStatusValue] = useState<TaskStatus>("todo")
  const [priority, setPriority] = useState<Priority>("medium")
  const [assignee, setAssignee] = useState("")
  const [needsHumanReview, setNeedsHumanReview] = useState(false)
  const [selectedTeamId, setSelectedTeamId] = useState("")
  const [attachments, setAttachments] = useState<TaskAttachment[]>([])
  const [comments, setComments] = useState<TaskComment[]>([])
  const [latestTaskSessionByKey, setLatestTaskSessionByKey] = useState<Record<string, string>>({})

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [commentsLoading, setCommentsLoading] = useState(false)
  const [commentSubmitting, setCommentSubmitting] = useState(false)
  const [commentBusyId, setCommentBusyId] = useState<string | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [commentsError, setCommentsError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [settingsDrawerOpen, setSettingsDrawerOpen] = useState(false)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const descriptionEditorRef = useRef<TaskDescriptionEditorHandle>(null)
  const activeTaskIdRef = useRef<string | null>(taskId ?? null)
  const commentsRequestSeqRef = useRef(0)
  const routeTeamId = teamId?.trim() ?? ""
  const showArchived = useMemo(
    () => shouldIncludeArchivedFromSearch(location.search),
    [location.search],
  )

  function resetDraftState() {
    commentsRequestSeqRef.current += 1
    setTask(null)
    setTeams([])
    setTitle("")
    setDescription("")
    setStatusValue("todo")
    setPriority("medium")
    setAssignee("")
    setNeedsHumanReview(false)
    setSelectedTeamId("")
    setAttachments([])
    setComments([])
    setLatestTaskSessionByKey({})
    setCommentsLoading(false)
    setCommentSubmitting(false)
    setCommentBusyId(null)
    setUploadError(null)
    setCommentsError(null)
  }

  function insertInlineImageAtCursor(attachment: TaskAttachment) {
    const markerIndex = descriptionEditorRef.current?.insertInlineImageMarkerAtCursor()
    if (markerIndex === undefined || markerIndex < 0) {
      setDescription((prev) => `${prev}${INLINE_IMAGE_MARKER}`)
      setAttachments((prev) => [...prev, attachment])
      return
    }

    setAttachments((prev) => {
      const nextAttachments = [...prev]
      nextAttachments.splice(markerIndex, 0, attachment)
      return nextAttachments
    })
  }

  const loadTaskSessionMap = useCallback(async () => {
    try {
      const result = await rpc("sessions.list") as { sessions?: SessionListEntry[] }
      const sessions = Array.isArray(result.sessions) ? result.sessions : []
      setLatestTaskSessionByKey(buildTaskSessionMap(sessions))
    } catch {
      setLatestTaskSessionByKey({})
    }
  }, [rpc])

  const loadComments = useCallback(async (targetTaskId: string, showLoading = true): Promise<boolean> => {
    const requestSeq = commentsRequestSeqRef.current + 1
    commentsRequestSeqRef.current = requestSeq
    const isActiveTask = activeTaskIdRef.current === targetTaskId
    if (showLoading && isActiveTask) setCommentsLoading(true)
    try {
      const result = await rpc("tasks.listComments", { taskId: targetTaskId }) as { comments?: TaskComment[] }
      if (requestSeq !== commentsRequestSeqRef.current) return false
      if (activeTaskIdRef.current !== targetTaskId) return false
      const nextComments = Array.isArray(result.comments) ? result.comments : []
      setComments(nextComments)
      setCommentsError(null)
      return true
    } catch (err) {
      if (requestSeq !== commentsRequestSeqRef.current) return false
      if (activeTaskIdRef.current !== targetTaskId) return false
      setCommentsError(err instanceof Error ? err.message : t("tasks.commentsLoadFailed"))
      return false
    } finally {
      if (showLoading && requestSeq === commentsRequestSeqRef.current && activeTaskIdRef.current === targetTaskId) {
        setCommentsLoading(false)
      }
    }
  }, [rpc, t])

  useEffect(() => {
    activeTaskIdRef.current = taskId ?? null
  }, [taskId])

  useEffect(() => {
    setSettingsDrawerOpen(false)
  }, [taskId])

  useEffect(() => {
    if (status !== "connected" || !taskId) return

    let cancelled = false
    setLoading(true)
    setError(null)
    resetDraftState()

    Promise.all([
      rpc("tasks.list", { includeArchived: true }) as Promise<{ tasks: Task[] }>,
      (rpc("chat.teams") as Promise<{ teams: TeamConfig[] }>)
        .catch(() => ({ teams: [] })),
      (rpc("sessions.list") as Promise<{ sessions?: SessionListEntry[] }>)
        .catch(() => ({ sessions: [] })),
    ])
      .then(([taskResult, teamResult, sessionResult]) => {
        if (cancelled) return

        const matchedTask = resolveTaskFromRoute(taskResult.tasks, { taskId, teamId: routeTeamId })
        const teamList = teamResult.teams ?? []
        const sessions = Array.isArray(sessionResult.sessions) ? sessionResult.sessions : []
        setTeams(teamList)
        setLatestTaskSessionByKey(buildTaskSessionMap(sessions))

        if (!matchedTask) {
          setTask(null)
          setError(t("tasks.taskNotFound"))
          return
        }

        const originalDescription = matchedTask.description || ""
        const { descriptionWithMarkers, inlineAttachmentIds } =
          toEditorDescriptionWithInlineMarkers(originalDescription)
        const attachmentById = new Map(
          matchedTask.attachments.map((attachment) => [attachment.id, attachment]),
        )
        const orderedInlineAttachments = inlineAttachmentIds
          .map((attachmentId) => attachmentById.get(attachmentId))
          .filter((attachment): attachment is TaskAttachment => Boolean(attachment))
        const fallbackAttachments = matchedTask.attachments.filter(
          (attachment) => !inlineAttachmentIds.includes(attachment.id),
        )
        const fallbackInlineMarkers = fallbackAttachments
          .map(() => `\n${INLINE_IMAGE_MARKER}\n`)
          .join("")

        setTask(matchedTask)
        setTitle(matchedTask.title)
        setDescription(`${descriptionWithMarkers}${fallbackInlineMarkers}`)
        setStatusValue(matchedTask.status)
        setPriority(matchedTask.priority)
        setAssignee(matchedTask.assignee || "")
        setNeedsHumanReview(matchedTask.needsHumanReview)
        setAttachments([...orderedInlineAttachments, ...fallbackAttachments])
        setSelectedTeamId(resolveInitialTeamId(matchedTask.teamId, teamList))
        setUploadError(null)
        setComments([])
        setCommentsError(null)
        setError(null)
        void loadComments(matchedTask.id)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        resetDraftState()
        setError(err instanceof Error ? err.message : "Failed to load task")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => { cancelled = true }
  }, [rpc, status, taskId, routeTeamId, t, loadComments])

  useEffect(() => {
    if (status !== "connected" || !taskId) return
    return onTaskEvent((event) => {
      const isCommentEvent = event.action === "commentAdded"
        || event.action === "commentUpdated"
        || event.action === "commentDeleted"
      if (isCommentEvent) {
        if (event.taskId && event.taskId !== taskId) return
        void loadComments(taskId, false)
        return
      }

      if (event.action !== "updated" || !event.task) return
      const updatedTask = event.task as Partial<Task>
      if (updatedTask.id !== taskId) return
      if (typeof updatedTask.needsHumanReview === "boolean") {
        setNeedsHumanReview(updatedTask.needsHumanReview)
      }
      setTask((prev) => {
        if (!prev) return prev
        return {
          ...prev,
          needsHumanReview: typeof updatedTask.needsHumanReview === "boolean"
            ? updatedTask.needsHumanReview
            : prev.needsHumanReview,
          claimedBy: typeof updatedTask.claimedBy === "string" || updatedTask.claimedBy === null
            ? updatedTask.claimedBy
            : prev.claimedBy,
          claimedAt: typeof updatedTask.claimedAt === "number" || updatedTask.claimedAt === null
            ? updatedTask.claimedAt
            : prev.claimedAt,
          updatedAt: typeof updatedTask.updatedAt === "number" ? updatedTask.updatedAt : prev.updatedAt,
        }
      })
      void loadTaskSessionMap()
    })
  }, [status, taskId, onTaskEvent, loadTaskSessionMap, loadComments])

  async function handleSubmit() {
    if (!task || !title.trim() || saving) return
    setSaving(true)
    setError(null)
    try {
      const descriptionValue = buildDescriptionWithInlineImages(description, attachments)
      const updatePayload = {
        id: task.id,
        title: title.trim(),
        description: descriptionValue || null,
        status: statusValue,
        priority,
        teamId: selectedTeamId || null,
        assignee: assignee.trim() || null,
        attachments,
        ...(needsHumanReview !== task.needsHumanReview ? { needsHumanReview } : {}),
      }

      await rpc("tasks.update", updatePayload)
      void navigate(tasksListPath)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update task")
    } finally {
      setSaving(false)
    }
  }

  function handleFormKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && title.trim()) {
      e.preventDefault()
      void handleSubmit()
    }
  }

  const uploadFile = useCallback(async (file: File) => {
    setUploadError(null)

    if (!isSupportedTaskImageType(file.type)) {
      setUploadError(t("tasks.imageTypeNotSupported"))
      return
    }
    if (file.size > MAX_TASK_IMAGE_UPLOAD_BYTES) {
      setUploadError(t("tasks.imageTooLarge"))
      return
    }

    const reservedMarkerIndex = descriptionEditorRef.current?.insertInlineImageMarkerAtCursor()
    const hasReservedMarker = typeof reservedMarkerIndex === "number" && reservedMarkerIndex >= 0

    setUploading(true)
    try {
      const data = await taskImageFileToBase64(file)
      const attachment = await rpc("tasks.uploadAttachment", {
        name: file.name,
        type: file.type,
        data,
      }) as TaskAttachment
      if (hasReservedMarker) {
        setAttachments((prev) => {
          const nextAttachments = [...prev]
          nextAttachments.splice(reservedMarkerIndex, 0, attachment)
          return nextAttachments
        })
      } else {
        insertInlineImageAtCursor(attachment)
      }
    } catch {
      if (hasReservedMarker) {
        setDescription((prev) => removeInlineImageMarkerByIndex(prev, reservedMarkerIndex))
      }
      setUploadError(t("tasks.uploadFailed"))
    } finally {
      setUploading(false)
    }
  }, [rpc, t])

  function handleFileSelect(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) void uploadFile(file)
    e.target.value = ""
  }

  async function handlePasteImages(imageFiles: File[]) {
    for (const imageFile of imageFiles) {
      await uploadFile(imageFile)
    }
  }

  function handleRemoveInlineImageAtIndex(markerIndex: number) {
    setAttachments((prev) => prev.filter((_, index) => index !== markerIndex))
  }

  async function handleAddComment(content: string): Promise<boolean> {
    if (!task || commentSubmitting) return false
    setCommentsError(null)
    setCommentSubmitting(true)
    try {
      await rpc("tasks.addComment", { taskId: task.id, content })
      void loadComments(task.id, false)
      return true
    } catch (err) {
      setCommentsError(err instanceof Error ? err.message : t("tasks.commentsAddFailed"))
      return false
    } finally {
      setCommentSubmitting(false)
    }
  }

  async function handleUpdateComment(commentId: string, content: string): Promise<boolean> {
    if (!task || commentBusyId) return false
    setCommentsError(null)
    setCommentBusyId(commentId)
    try {
      await rpc("tasks.updateComment", { id: commentId, content })
      void loadComments(task.id, false)
      return true
    } catch (err) {
      setCommentsError(err instanceof Error ? err.message : t("tasks.commentsUpdateFailed"))
      return false
    } finally {
      setCommentBusyId(null)
    }
  }

  async function handleDeleteComment(commentId: string): Promise<void> {
    if (!task || commentBusyId) return
    setCommentsError(null)
    setCommentBusyId(commentId)
    try {
      await rpc("tasks.deleteComment", { id: commentId })
      void loadComments(task.id, false)
    } catch (err) {
      setCommentsError(err instanceof Error ? err.message : t("tasks.commentsDeleteFailed"))
    } finally {
      setCommentBusyId(null)
    }
  }

  // Derive status columns from the task's team.
  const baseStatusColumns = useMemo(() => {
    const team = teams.find((t) => t.id === selectedTeamId)
    const teamStatuses = team?.statuses
    return buildStatusColumns(teamStatuses && teamStatuses.length > 0 ? teamStatuses : DEFAULT_TASK_STATUSES)
  }, [teams, selectedTeamId])
  const archivedStatusColor = useMemo(
    () => baseStatusColumns.find((column) => column.key === "done")?.color
      ?? DEFAULT_TASK_STATUSES.find((column) => column.key === "done")?.color
      ?? DEFAULT_TASK_STATUSES[0]?.color
      ?? "currentColor",
    [baseStatusColumns],
  )
  const shouldShowArchivedStatus = showArchived || statusValue === ARCHIVED_STATUS_KEY || task?.status === ARCHIVED_STATUS_KEY
  const statusColumns = useMemo(() => {
    if (!shouldShowArchivedStatus) return baseStatusColumns
    if (baseStatusColumns.some((column) => column.key === ARCHIVED_STATUS_KEY)) {
      return baseStatusColumns
    }
    return [...baseStatusColumns, {
      key: ARCHIVED_STATUS_KEY,
      label: t("tasks.archived"),
      color: archivedStatusColor,
    }]
  }, [shouldShowArchivedStatus, baseStatusColumns, archivedStatusColor, t])

  useEffect(() => {
    if (statusColumns.length === 0) return
    if (!statusColumns.some((column) => column.key === statusValue)) {
      setStatusValue(statusColumns[0]!.key)
    }
  }, [statusColumns, statusValue])

  const currentStatus = useMemo(
    () => statusColumns.find((column) => column.key === statusValue) ?? statusColumns[0],
    [statusValue, statusColumns],
  )
  const currentPriority = useMemo(
    () => PRIORITY_ICONS[priority],
    [priority],
  )
  const currentTeam = useMemo(
    () => teams.find((team) => team.id === selectedTeamId),
    [teams, selectedTeamId],
  )
  const agentNamesById = useMemo(() => {
    const map: Record<string, string> = {}
    for (const team of teams) {
      if (team.orchestrator?.id) map[team.orchestrator.id] = team.orchestrator.name
      for (const worker of team.workers ?? []) {
        if (worker.id) map[worker.id] = worker.name
      }
    }
    return map
  }, [teams])
  const runtimeTask = useMemo(() => {
    if (!task) return null
    return {
      ...task,
      teamId: selectedTeamId || task.teamId,
      status: statusValue,
      assignee: assignee.trim() || null,
      needsHumanReview,
    }
  }, [task, selectedTeamId, statusValue, assignee, needsHumanReview])
  const subscribedWorkerNames = useMemo(() => {
    if (!runtimeTask) return []
    return getSubscribedWorkerIds(runtimeTask, teams)
      .map((workerId) => agentNamesById[workerId] ?? workerId)
  }, [runtimeTask, teams, agentNamesById])
  const runningAgentName = useMemo(() => {
    if (!task?.claimedBy) return null
    return agentNamesById[task.claimedBy] ?? task.claimedBy
  }, [task, agentNamesById])
  const latestSessionKey = useMemo(() => {
    if (!task) return undefined
    return latestTaskSessionByKey[getTaskMapKey(task)]
  }, [task, latestTaskSessionByKey])
  const isArchivedContext = statusValue === ARCHIVED_STATUS_KEY
  const tasksListPath = useMemo(() => {
    if (selectedTeamId) return isArchivedContext ? buildArchivedTasksPath(selectedTeamId) : buildTasksListPath(selectedTeamId)
    if (routeTeamId) return isArchivedContext ? buildArchivedTasksPath(routeTeamId) : buildTasksListPath(routeTeamId)
    if (task?.teamId) return isArchivedContext ? buildArchivedTasksPath(task.teamId) : buildTasksListPath(task.teamId)
    return isArchivedContext ? buildArchivedTasksPath(null) : buildTasksListPath(null)
  }, [selectedTeamId, routeTeamId, task?.teamId, isArchivedContext])
  const taskLabel = useMemo(() => {
    if (!task) return ""
    const displayTask = {
      id: task.id,
      teamId: selectedTeamId || task.teamId,
    }
    return formatTaskLabel(displayTask, currentTeam?.name)
  }, [task, selectedTeamId, currentTeam?.name])
  const PriorityIcon = currentPriority.icon
  const showCompactDesktopMeta = isDesktop
  const settingsContainerClass = showCompactDesktopMeta ? "flex flex-col gap-2 p-3" : "flex flex-col gap-4 px-4 py-3"
  const settingsSectionClass = showCompactDesktopMeta
    ? "flex flex-col gap-1"
    : "flex flex-col gap-1.5 border-b border-border/70 pb-3 last:border-b-0 last:pb-0"
  const settingsOptionTriggerClass = showCompactDesktopMeta
    ? "h-9 w-full justify-start gap-2 rounded-md px-1.5 text-sm text-muted-foreground hover:bg-muted/30"
    : "h-9 w-full justify-between gap-3 rounded-md px-1 text-sm text-foreground hover:bg-muted/40"
  const settingsChevronClass = showCompactDesktopMeta ? "hidden" : "size-3.5 text-muted-foreground"
  const settingsReviewRowClass = showCompactDesktopMeta
    ? "flex h-9 items-center justify-between rounded-md px-1.5"
    : "flex h-9 items-center justify-between rounded-md px-1"
  const settingsRuntimeContainerClass = showCompactDesktopMeta
    ? "mt-1 border-t border-border/70 pt-3"
    : "pt-1"

  const runtimeSummarySection = (
    showCompactDesktopMeta ? (
      <div className="flex flex-col gap-2">
        {subscribedWorkerNames.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {subscribedWorkerNames.map((name) => (
              <span
                key={name}
                className="inline-flex items-center rounded-md bg-muted px-2 py-0.5 text-[11px] text-muted-foreground"
              >
                {name}
              </span>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">{t("tasks.noSubscribers")}</p>
        )}

        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <BotIcon className="size-3.5" />
          {runningAgentName
            ? t("teams.claimedBy", { name: runningAgentName })
            : t("tasks.notRunning")}
        </div>

        {latestSessionKey && (
          <Button
            variant="outline"
            size="sm"
            className="h-8 justify-start gap-1.5 text-xs"
            onClick={handleOpenLatestSession}
          >
            <ScrollTextIcon className="size-3.5" />
            {t("tasks.openLatestRunningSession")}
          </Button>
        )}
      </div>
    ) : (
      <div className="flex flex-col gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t("tasks.subscribers")}</p>
        <p className="text-sm text-muted-foreground">
          {subscribedWorkerNames.length > 0 ? subscribedWorkerNames.join(", ") : t("tasks.noSubscribers")}
        </p>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <BotIcon className="size-3.5" />
          {runningAgentName
            ? t("teams.claimedBy", { name: runningAgentName })
            : t("tasks.notRunning")}
        </div>
        {latestSessionKey && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 justify-start gap-1.5 px-1 text-xs text-muted-foreground hover:text-foreground"
            onClick={handleOpenLatestSession}
          >
            <ScrollTextIcon className="size-3.5" />
            {t("tasks.openLatestRunningSession")}
          </Button>
        )}
      </div>
    )
  )

  const settingsDrawerContent = (
    <div className={settingsContainerClass}>
      <div className={settingsSectionClass}>
        {!showCompactDesktopMeta && (
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t("tasks.status")}</p>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className={settingsOptionTriggerClass}>
              <span className="flex min-w-0 items-center gap-2">
                <span
                  className="size-3 rounded-full shrink-0"
                  style={{ backgroundColor: currentStatus?.color ?? "currentColor" }}
                />
                <span className="truncate">{currentStatus?.label ?? statusValue}</span>
              </span>
              <ChevronDownIcon className={settingsChevronClass} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-40">
            <DropdownMenuLabel>{t("tasks.status")}</DropdownMenuLabel>
            {statusColumns.map((column) => (
              <DropdownMenuItem key={column.key} onClick={() => setStatusValue(column.key)}>
                <span
                  className="size-3 rounded-full shrink-0"
                  style={{ backgroundColor: column.color }}
                />
                <span>{column.label}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className={settingsSectionClass}>
        {!showCompactDesktopMeta && (
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t("tasks.priority")}</p>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className={settingsOptionTriggerClass}>
              <span className="flex min-w-0 items-center gap-2">
                <PriorityIcon className={`size-4 ${currentPriority.color}`} />
                <span className="truncate">{t(priorityLabelKey(priority))}</span>
              </span>
              <ChevronDownIcon className={settingsChevronClass} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-40">
            <DropdownMenuLabel>{t("tasks.priority")}</DropdownMenuLabel>
            {PRIORITIES.map((value) => {
              const iconConfig = PRIORITY_ICONS[value]
              const Icon = iconConfig.icon
              return (
                <DropdownMenuItem key={value} onClick={() => setPriority(value)}>
                  <Icon className={`size-4 ${iconConfig.color}`} />
                  <span>{t(priorityLabelKey(value))}</span>
                </DropdownMenuItem>
              )
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {teams.length > 0 && (
        <div className={settingsSectionClass}>
          {!showCompactDesktopMeta && (
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t("tasks.team")}</p>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className={settingsOptionTriggerClass}>
                <span className="flex min-w-0 items-center gap-2">
                  <UsersIcon className="size-4 text-muted-foreground" />
                  <span className="truncate">{currentTeam ? (currentTeam.name || currentTeam.id) : selectedTeamId}</span>
                </span>
                <ChevronDownIcon className={settingsChevronClass} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-40">
              <DropdownMenuLabel>{t("tasks.team")}</DropdownMenuLabel>
              {teams.map((team) => (
                <DropdownMenuItem key={team.id} onClick={() => setSelectedTeamId(team.id)}>
                  <span>{team.name || team.id}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}

      <div className={settingsSectionClass}>
        {!showCompactDesktopMeta && (
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t("tasks.needsHumanReview")}</p>
        )}
        <div className={settingsReviewRowClass}>
          <span className="text-sm text-foreground">{t("tasks.needsHumanReview")}</span>
          <Switch
            checked={needsHumanReview}
            onCheckedChange={setNeedsHumanReview}
            aria-label={t("tasks.needsHumanReview")}
          />
        </div>
      </div>

      <div className={settingsRuntimeContainerClass}>
        {runtimeSummarySection}
      </div>
    </div>
  )

  function handleOpenLatestSession() {
    if (!latestSessionKey) return
    void navigate(`/sessions?sessionKey=${encodeURIComponent(latestSessionKey)}`)
  }

  if (status !== "connected") {
    return (
      <div data-slot="edit-task-page" className="flex h-full items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <WifiOffIcon className="size-8" />
          <p className="text-sm">
            {status === "connecting" ? t("common.connecting") : t("common.disconnected")}
          </p>
        </div>
      </div>
    )
  }

  if (loading) {
    return (
      <div data-slot="edit-task-page" className="flex h-full items-center justify-center">
        <LoaderIcon className="size-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!task) {
    return (
      <div data-slot="edit-task-page" className="flex h-full items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <p className="text-sm text-muted-foreground">{error || t("tasks.taskNotFound")}</p>
          <Button variant="outline" asChild>
            <Link to={tasksListPath}>{t("tasks.backToTasks")}</Link>
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div data-slot="edit-task-page" className="flex h-full flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2 sm:px-4 md:px-6">
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          <Link
            to={tasksListPath}
            className="flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeftIcon className="size-4" />
            {t("tasks.title")}
          </Link>
          <span className="text-muted-foreground">/</span>
          <h1 className="text-sm font-semibold text-foreground">{taskLabel}</h1>
          {saving && <LoaderIcon className="size-4 animate-spin text-muted-foreground" />}
          {error && (
            <span className="flex min-w-0 items-center gap-1 text-sm text-destructive">
              <AlertCircleIcon className="size-3.5" />
              <span className="truncate">{error}</span>
            </span>
          )}
        </div>
        <div className="flex w-full items-center gap-2 sm:w-auto">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t("tasks.details")}
            onClick={() => setSettingsDrawerOpen(true)}
            className="xl:hidden"
          >
            <SettingsIcon className="size-4" />
          </Button>
          <Button size="sm" variant="outline" asChild className="flex-1 sm:flex-none">
            <Link to={tasksListPath}>{t("common.cancel")}</Link>
          </Button>
          <Button size="sm" disabled={!title.trim() || saving} onClick={() => void handleSubmit()} className="flex-1 sm:flex-none">
            {saving ? <LoaderIcon className="mr-1.5 size-3.5 animate-spin" /> : <SaveIcon className="mr-1.5 size-3.5" />}
            {t("common.save")}
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col xl:flex-row">
        <div className="min-h-0 flex-1 overflow-y-auto" onKeyDown={handleFormKeyDown}>
          <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-3 py-4 sm:px-4 sm:py-5 md:px-6 md:py-6">
            <section className="p-0">
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t("tasks.taskTitlePlaceholder")}
                className="w-full bg-transparent text-2xl font-semibold leading-tight text-foreground placeholder:text-muted-foreground/60 outline-none"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && title.trim()) {
                    e.preventDefault()
                    void handleSubmit()
                  }
                }}
              />

              <TaskDescriptionEditor
                ref={descriptionEditorRef}
                value={description}
                attachments={attachments}
                placeholder={t("tasks.taskDescriptionPlaceholder")}
                className="mt-3 text-base"
                onChange={setDescription}
                onRemoveImageAtIndex={handleRemoveInlineImageAtIndex}
                onPasteImages={handlePasteImages}
              />

              <div className="mt-3 flex items-center justify-start">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => { setUploadError(null); fileInputRef.current?.click() }}
                  disabled={uploading}
                  aria-label={t("tasks.addImage")}
                  className="gap-1.5 px-0 text-muted-foreground hover:bg-transparent hover:text-foreground"
                >
                  {uploading ? <LoaderIcon className="size-3.5 animate-spin" /> : <PaperclipIcon className="size-3.5" />}
                  {uploading ? t("common.loading") : t("tasks.addImage")}
                </Button>
              </div>

              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                className="hidden"
                onChange={handleFileSelect}
              />

              {uploadError && (
                <p className="mt-2 text-xs text-destructive">{uploadError}</p>
              )}
            </section>

            <TaskCommentsPanel
              comments={comments}
              loading={commentsLoading}
              submitting={commentSubmitting}
              busyCommentId={commentBusyId}
              error={commentsError}
              authorNamesById={agentNamesById}
              onAdd={handleAddComment}
              onUpdate={handleUpdateComment}
              onDelete={handleDeleteComment}
            />
          </div>
        </div>

        <aside className="hidden min-h-0 w-80 shrink-0 border-l border-border bg-background xl:block">
          <div className="h-full overflow-y-auto">
            {settingsDrawerContent}
          </div>
        </aside>
      </div>

      {!isDesktop && (
        <Dialog open={settingsDrawerOpen} onOpenChange={setSettingsDrawerOpen}>
          <DialogContent className="!top-0 !right-0 !left-auto !h-dvh !w-80 !max-w-full !translate-x-0 !translate-y-0 !rounded-none !p-0 !gap-0 !flex !flex-col">
            <DialogTitle className="sr-only">{t("tasks.details")}</DialogTitle>
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <p className="text-sm font-semibold text-foreground">{t("tasks.details")}</p>
              <DialogClose asChild>
                <Button type="button" variant="ghost" size="icon-sm" aria-label={t("common.close")}>
                  <XIcon className="size-4" />
                </Button>
              </DialogClose>
            </div>
            <div className="min-h-0 overflow-y-auto">
              {settingsDrawerContent}
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
