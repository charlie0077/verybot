import { useState, useEffect, useRef, useCallback, useMemo } from "react"
import { useTranslation } from "react-i18next"
import { PaperclipIcon, LoaderIcon, UsersIcon } from "lucide-react"
import { useGatewayContext } from "@/contexts/gateway-context"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu"
import {
  PRIORITIES,
  PRIORITY_ICONS,
  DEFAULT_TASK_STATUSES,
  buildStatusColumns,
  type Priority,
  type TaskAttachment,
  type TaskStatus,
  type TeamConfig,
  type StatusColumnConfig,
} from "./types"
import {
  INLINE_IMAGE_MARKER,
  buildDescriptionWithInlineImages,
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

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

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

function resolveInitialTeamId(teamId: string | null, teams: TeamConfig[]): string {
  if (teamId && teams.some((team) => team.id === teamId)) return teamId
  const defaultTeam = teams.find((team) => team.id === "default")
  return defaultTeam?.id ?? teams[0]?.id ?? ""
}

/* ------------------------------------------------------------------ */
/*  Add Task Modal                                                     */
/* ------------------------------------------------------------------ */

export interface AddTaskModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  teamId: string | null
  teams: TeamConfig[]
  statusColumns?: StatusColumnConfig[]
  initialStatus: TaskStatus
  onSave: (input: { title: string; description?: string; teamId?: string; priority: Priority; status: TaskStatus; attachments?: TaskAttachment[] }) => void | Promise<void>
}

export function AddTaskModal({ open, onOpenChange, teamId, teams, statusColumns: statusColumnsProp, initialStatus, onSave }: AddTaskModalProps) {
  const { t } = useTranslation()
  const { rpc } = useGatewayContext()

  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [priority, setPriority] = useState<Priority>("medium")
  const [status, setStatus] = useState<TaskStatus>(initialStatus)
  const [selectedTeamId, setSelectedTeamId] = useState(resolveInitialTeamId(teamId, teams))
  const [attachments, setAttachments] = useState<TaskAttachment[]>([])
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const descriptionEditorRef = useRef<TaskDescriptionEditorHandle>(null)

  const selectedTeamColumns = useMemo(
    () => {
      const teamStatuses = teams.find((team) => team.id === selectedTeamId)?.statuses
      return buildStatusColumns(teamStatuses && teamStatuses.length > 0 ? teamStatuses : DEFAULT_TASK_STATUSES)
    },
    [teams, selectedTeamId],
  )

  // Use parent-provided columns only for the currently viewed team.
  const columns = useMemo(() => {
    if (statusColumnsProp && selectedTeamId === teamId) return statusColumnsProp
    return selectedTeamColumns
  }, [statusColumnsProp, selectedTeamColumns, selectedTeamId, teamId])

  const currentStatusCol = columns.find((c) => c.key === status) ?? columns[0]

  useEffect(() => {
    if (open) {
      setTitle("")
      setDescription("")
      setPriority("medium")
      setStatus(initialStatus)
      setSelectedTeamId(resolveInitialTeamId(teamId, teams))
      setAttachments([])
      setUploadError(null)
      setIsSubmitting(false)
      if (fileInputRef.current) {
        fileInputRef.current.value = ""
      }
    }
  }, [open, teamId, initialStatus, teams])

  useEffect(() => {
    if (!open || teams.length === 0) return
    if (selectedTeamId && teams.some((team) => team.id === selectedTeamId)) return
    setSelectedTeamId(resolveInitialTeamId(teamId, teams))
  }, [open, teamId, teams, selectedTeamId])

  useEffect(() => {
    if (columns.length === 0) return
    if (!columns.some((column) => column.key === status)) {
      setStatus(columns[0]!.key)
    }
  }, [columns, status])

  async function handleSubmit() {
    if (!title.trim() || isSubmitting) return
    setIsSubmitting(true)
    try {
      const descriptionValue = buildDescriptionWithInlineImages(description, attachments)

      await onSave({
        title: title.trim(),
        description: descriptionValue || undefined,
        teamId: selectedTeamId || undefined,
        priority,
        status,
        attachments: attachments.length > 0 ? attachments : undefined,
      })
      onOpenChange(false)
    } finally {
      setIsSubmitting(false)
    }
  }

  /** Handles Cmd/Ctrl+Enter from anywhere inside the form. */
  function handleFormKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && title.trim()) {
      e.preventDefault()
      handleSubmit()
    }
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

    setUploading(true)
    try {
      const data = await taskImageFileToBase64(file)
      const attachment = await rpc("tasks.uploadAttachment", {
        name: file.name,
        type: file.type,
        data,
      }) as TaskAttachment
      insertInlineImageAtCursor(attachment)
    } catch {
      setUploadError(t("tasks.uploadFailed"))
    } finally {
      setUploading(false)
    }
  }, [rpc, t])

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) uploadFile(file)
    e.target.value = ""
  }

  async function handlePasteImages(imageFiles: File[]) {
    for (const imageFile of imageFiles) {
      await uploadFile(imageFile)
    }
  }

  function handleRemoveInlineImageAtIndex(markerIndex: number, _attachmentId?: string) {
    setAttachments((prev) => prev.filter((_, index) => index !== markerIndex))
  }

  // Current priority data
  const currentPriority = PRIORITY_ICONS[priority]
  const PriorityIcon = currentPriority.icon

  // Current team name
  const currentTeam = teams.find((team) => team.id === selectedTeamId)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 p-0 max-w-lg">
        {/* Visually hidden title & description for accessibility */}
        <DialogTitle className="sr-only">{t("tasks.newTask")}</DialogTitle>
        <DialogDescription className="sr-only">{t("tasks.newTaskDescription")}</DialogDescription>

        {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
        <div className="flex flex-col" onKeyDown={handleFormKeyDown}>
          {/* ── Title input ── */}
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t("tasks.taskTitlePlaceholder")}
            className="w-full bg-transparent px-5 pt-5 pb-1 text-base font-medium placeholder:text-muted-foreground/60 outline-none"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && title.trim()) {
                e.preventDefault()
                handleSubmit()
              }
            }}
          />

          {/* ── Description input ── */}
          <div className="px-5 py-2">
            <TaskDescriptionEditor
              ref={descriptionEditorRef}
              value={description}
              attachments={attachments}
              placeholder={t("tasks.taskDescriptionPlaceholder")}
              className="min-h-[100px] text-sm"
              onChange={setDescription}
              onRemoveImageAtIndex={handleRemoveInlineImageAtIndex}
              onPasteImages={handlePasteImages}
            />
          </div>

          {/* ── Upload error ── */}
          {uploadError && (
            <p className="px-5 pb-1 text-xs text-destructive">{uploadError}</p>
          )}

          {/* ── Bottom toolbar ── */}
          <div className="flex items-center gap-1 border-t border-border px-3 py-2">
            {/* Status dropdown */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="xs" className="gap-1.5 px-2">
                  <span
                    className="size-2.5 rounded-full shrink-0"
                    style={{ backgroundColor: currentStatusCol?.color ?? "#64748b" }}
                  />
                  <span className="text-xs text-muted-foreground">{currentStatusCol?.label ?? status}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-36">
                <DropdownMenuLabel>{t("tasks.status")}</DropdownMenuLabel>
                {columns.map((col) => (
                  <DropdownMenuItem
                    key={col.key}
                    onClick={() => setStatus(col.key)}
                  >
                    <span
                      className="size-3 rounded-full shrink-0"
                      style={{ backgroundColor: col.color }}
                    />
                    <span>{col.label}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Priority dropdown */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="xs" className="gap-1.5 px-2">
                  <PriorityIcon className={`size-3.5 ${currentPriority.color}`} />
                  <span className="text-xs text-muted-foreground">{t(priorityLabelKey(priority))}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-36">
                <DropdownMenuLabel>{t("tasks.priority")}</DropdownMenuLabel>
                {PRIORITIES.map((p) => {
                  const pData = PRIORITY_ICONS[p]
                  const Icon = pData.icon
                  return (
                    <DropdownMenuItem
                      key={p}
                      onClick={() => setPriority(p)}
                    >
                      <Icon className={`size-4 ${pData.color}`} />
                      <span>{t(priorityLabelKey(p))}</span>
                    </DropdownMenuItem>
                  )
                })}
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Team dropdown (only if teams exist) */}
            {teams.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="xs" className="gap-1.5 px-2">
                    <UsersIcon className="size-3.5 text-muted-foreground" />
                    <span className="text-xs text-muted-foreground">
                      {currentTeam ? (currentTeam.name || currentTeam.id) : selectedTeamId}
                    </span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-36">
                  <DropdownMenuLabel>{t("tasks.team")}</DropdownMenuLabel>
                  {teams.map((team) => (
                    <DropdownMenuItem
                      key={team.id}
                      onClick={() => setSelectedTeamId(team.id)}
                    >
                      <span>{team.name || team.id}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}

            {/* Attachment button */}
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => { setUploadError(null); fileInputRef.current?.click() }}
              disabled={uploading}
              aria-label={t("tasks.addImage")}
            >
              {uploading ? (
                <LoaderIcon className="size-3.5 animate-spin text-muted-foreground" />
              ) : (
                <PaperclipIcon className="size-3.5 text-muted-foreground" />
              )}
            </Button>

            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              className="hidden"
              onChange={handleFileSelect}
            />

            {/* Spacer */}
            <div className="flex-1" />

            {/* Create button */}
            <Button size="xs" disabled={!title.trim() || isSubmitting} onClick={handleSubmit}>
              {isSubmitting && <LoaderIcon className="size-3 animate-spin" />}
              {t("common.create")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
