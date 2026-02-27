import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Link, useNavigate, useParams } from "react-router"
import {
  ArrowLeftIcon,
  SaveIcon,
  LoaderIcon,
  CheckIcon,
  AlertCircleIcon,
  Trash2Icon,
  ChevronDownIcon,
  ChevronRightIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
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
import { useGatewayContext } from "@/contexts/gateway-context"
import { usePlaybooksContext } from "./playbooks-layout"
import type { PlaybookDetail, PlaybookScriptCodeFile } from "./types"
import { PLAYBOOK_NAME_PATTERN } from "./types"
import { MarkdownEditor } from "@/components/ui/markdown-editor"
import { LiveSyntaxEditor } from "@/components/ui/live-syntax-editor"
import { cn } from "@/lib/utils"

const DEFAULT_README_TEMPLATE = "# New Playbook\n\n## When to use\n- TODO\n\n## Steps\n- TODO\n"
const NEW_PLAYBOOK_ROUTE_PARAM = "__new"
const README_FILE_NAME = "README.md"
const SCRIPT_EDITOR_FOCUS_DELAY_AFTER_EXPAND_MS = 120

interface DraftState {
  name: string
  description: string
  triggersInput: string
  tagsInput: string
  readme: string
  scriptFiles: string[]
  scriptCodeFiles: PlaybookScriptCodeFile[]
  inIndex: boolean
  onDisk: boolean
  readmeExists: boolean
}

const EMPTY_DRAFT: DraftState = {
  name: "",
  description: "",
  triggersInput: "",
  tagsInput: "",
  readme: DEFAULT_README_TEMPLATE,
  scriptFiles: [],
  scriptCodeFiles: [],
  inIndex: true,
  onDisk: true,
  readmeExists: true,
}

function normalizeCsv(value: string): string[] {
  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)

  const deduped = new Set<string>()
  for (const part of parts) deduped.add(part)
  return Array.from(deduped)
}

function formatCsv(values: string[]): string {
  return values.join(", ")
}

function buildScriptCodeFiles(
  scriptFiles: string[],
  scriptCodeFiles: PlaybookScriptCodeFile[],
): PlaybookScriptCodeFile[] {
  const contentByPath = new Map(scriptCodeFiles.map((scriptFile) => [scriptFile.path, scriptFile.content]));
  const result = scriptFiles.map((path) => ({ path, content: contentByPath.get(path) ?? "" }));

  for (const scriptFile of scriptCodeFiles) {
    if (contentByPath.has(scriptFile.path) && !scriptFiles.includes(scriptFile.path)) {
      result.push(scriptFile)
    }
  }

  return result
}

export function PlaybookDetailPage() {
  const { t } = useTranslation()
  const { name: paramName } = useParams<{ name: string }>()
  const navigate = useNavigate()
  const { rpc } = useGatewayContext()
  const { playbooks, saveState, error, createPlaybook, updatePlaybook, renamePlaybook, deletePlaybook } = usePlaybooksContext()

  const isNew = !paramName || paramName === NEW_PLAYBOOK_ROUTE_PARAM

  const [draft, setDraft] = useState<DraftState>({ ...EMPTY_DRAFT })
  const [originalName, setOriginalName] = useState("")
  const [nameError, setNameError] = useState<string | null>(null)
  const [fetching, setFetching] = useState(!isNew)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const scriptCardRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const [collapsedFiles, setCollapsedFiles] = useState<Record<string, boolean>>({})

  useEffect(() => {
    if (isNew) {
      setDraft({ ...EMPTY_DRAFT })
      setOriginalName("")
      setNameError(null)
      setFetching(false)
      return
    }

    let cancelled = false
    setFetching(true)

    rpc("playbooks.get", { name: paramName })
      .then((result) => {
        if (cancelled) return
        const playbook = (result as { playbook?: PlaybookDetail })?.playbook
        if (!playbook) {
          void navigate("/playbooks", { replace: true })
          return
        }

        const nextScriptCodeFiles = buildScriptCodeFiles(playbook.scriptFiles, playbook.scriptCodeFiles)

        setDraft({
          name: playbook.name,
          description: playbook.description,
          triggersInput: formatCsv(playbook.triggers),
          tagsInput: formatCsv(playbook.tags),
          readme: playbook.readme || DEFAULT_README_TEMPLATE,
          scriptFiles: playbook.scriptFiles,
          scriptCodeFiles: nextScriptCodeFiles,
          inIndex: playbook.inIndex,
          onDisk: playbook.onDisk,
          readmeExists: playbook.readmeExists,
        })
        setOriginalName(playbook.name)
        setNameError(null)
      })
      .catch(() => {
        if (!cancelled) void navigate("/playbooks", { replace: true })
      })
      .finally(() => {
        if (!cancelled) setFetching(false)
      })

    return () => { cancelled = true }
  }, [isNew, navigate, paramName, rpc])

  function validateName(value: string): string | null {
    const trimmed = value.trim()
    if (!trimmed) return t("playbooks.nameRequired")
    if (!PLAYBOOK_NAME_PATTERN.test(trimmed)) return t("playbooks.nameInvalid")

    const duplicate = playbooks.some(
      (playbook) => playbook.name.toLowerCase() === trimmed.toLowerCase() && playbook.name !== originalName,
    )
    if (duplicate) return t("playbooks.nameDuplicate")

    return null
  }

  function handleNameChange(value: string) {
    setDraft((prev) => ({ ...prev, name: value }))
    setNameError(validateName(value))
  }

  function handleScriptContentChange(path: string, content: string) {
    setDraft((prev) => ({
      ...prev,
      scriptCodeFiles: prev.scriptCodeFiles.map((scriptFile) => (
        scriptFile.path === path
          ? { ...scriptFile, content }
          : scriptFile
      )),
    }))
  }

  function isFileCollapsed(path: string): boolean {
    return collapsedFiles[path] ?? false
  }

  function handleToggleFileFold(path: string) {
    setCollapsedFiles((prev) => ({
      ...prev,
      [path]: !(prev[path] ?? false),
    }))
  }

  function focusScriptEditor(path: string, delayMs = 0) {
    const focusEditor = () => {
      const target = scriptCardRefs.current[path]
      if (!target) return
      target.scrollIntoView({ behavior: "smooth", block: "start" })
      requestAnimationFrame(() => {
        const editorTarget = target.querySelector<HTMLElement>(".cm-content")
        editorTarget?.focus()
      })
    }

    if (delayMs > 0) {
      setTimeout(focusEditor, delayMs)
      return
    }

    focusEditor()
  }

  function handleScriptBadgeClick(path: string) {
    const wasCollapsed = isFileCollapsed(path)
    if (wasCollapsed) {
      setCollapsedFiles((prev) => ({ ...prev, [path]: false }))
    }
    focusScriptEditor(path, wasCollapsed ? SCRIPT_EDITOR_FOCUS_DELAY_AFTER_EXPAND_MS : 0)
  }

  async function handleSave() {
    const normalizedName = draft.name.trim()
    const errorMessage = validateName(normalizedName)
    setNameError(errorMessage)
    if (errorMessage) return

    const description = draft.description.trim()
    const triggers = normalizeCsv(draft.triggersInput)
    const tags = normalizeCsv(draft.tagsInput)
    const readme = draft.readme
    const scriptCodeFiles = draft.scriptCodeFiles

    if (isNew) {
      const created = await createPlaybook({
        name: normalizedName,
        description,
        triggers,
        tags,
        readme,
      })
      if (created) {
        void navigate(`/playbooks/${encodeURIComponent(normalizedName)}`)
      }
      return
    }

    const renamed = normalizedName !== originalName
    const updated = await updatePlaybook({
      name: originalName,
      description,
      triggers,
      tags,
      readme,
      scriptCodeFiles,
    })
    if (!updated) return

    if (renamed) {
      const moved = await renamePlaybook(originalName, normalizedName)
      if (!moved) return
      setOriginalName(normalizedName)
      setDraft((prev) => ({ ...prev, name: normalizedName }))
      void navigate(`/playbooks/${encodeURIComponent(normalizedName)}`, { replace: true })
    }
  }

  async function handleDelete() {
    if (isNew || !originalName) return
    const deleted = await deletePlaybook(originalName)
    if (deleted) {
      setDeleteOpen(false)
      void navigate("/playbooks")
    }
  }

  const canSave = draft.name.trim().length > 0 && !nameError
  const isReadmeCollapsed = isFileCollapsed(README_FILE_NAME)

  if (fetching) {
    return (
      <div className="flex h-full items-center justify-center">
        <LoaderIcon className="size-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div data-slot="playbook-detail-page" className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-6 py-2">
        <div className="flex items-center gap-3">
          <Button size="icon" variant="ghost" asChild>
            <Link to="/playbooks">
              <ArrowLeftIcon className="size-4" />
            </Link>
          </Button>
          <h1 className="text-lg font-semibold text-foreground">
            {isNew ? t("playbooks.newPlaybook") : draft.name}
          </h1>
          {!draft.inIndex && (
            <Badge variant="destructive" className="text-xs">
              {t("playbooks.statusMissingIndex")}
            </Badge>
          )}
          {!draft.onDisk && (
            <Badge variant="destructive" className="text-xs">
              {t("playbooks.statusMissingDir")}
            </Badge>
          )}
          {draft.onDisk && !draft.readmeExists && (
            <Badge variant="destructive" className="text-xs">
              {t("playbooks.statusMissingReadme")}
            </Badge>
          )}
          {saveState === "saved" && (
            <span className="flex items-center gap-1 text-sm text-success">
              <CheckIcon className="size-3.5" />
              {t("common.saved")}
            </span>
          )}
          {saveState === "saving" && (
            <LoaderIcon className="size-4 animate-spin text-muted-foreground" />
          )}
          {error && (
            <span className="flex items-center gap-1 text-sm text-destructive">
              <AlertCircleIcon className="size-3.5" />
              {error}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {!isNew && (
            <Button size="sm" variant="outline" onClick={() => setDeleteOpen(true)}>
              <Trash2Icon className="mr-1.5 size-3.5" />
              {t("common.delete")}
            </Button>
          )}
          <Button size="sm" variant="outline" asChild>
            <Link to="/playbooks">{t("common.cancel")}</Link>
          </Button>
          <Button size="sm" disabled={!canSave || saveState === "saving"} onClick={handleSave}>
            <SaveIcon className="mr-1.5 size-3.5" />
            {isNew ? t("common.create") : t("common.save")}
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto flex max-w-6xl flex-col gap-6">
          <div className="grid gap-6 md:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label>{t("common.name")}</Label>
              <Input
                value={draft.name}
                onChange={(event) => handleNameChange(event.target.value)}
                placeholder={t("playbooks.namePlaceholder")}
              />
              {nameError && (
                <p className="text-xs text-destructive">{nameError}</p>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label>{t("common.description")}</Label>
              <Input
                value={draft.description}
                onChange={(event) => setDraft((prev) => ({ ...prev, description: event.target.value }))}
                placeholder={t("playbooks.descriptionPlaceholder")}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label>{t("playbooks.triggersLabel")}</Label>
              <Input
                value={draft.triggersInput}
                onChange={(event) => setDraft((prev) => ({ ...prev, triggersInput: event.target.value }))}
                placeholder={t("playbooks.triggersPlaceholder")}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label>{t("playbooks.tagsLabel")}</Label>
              <Input
                value={draft.tagsInput}
                onChange={(event) => setDraft((prev) => ({ ...prev, tagsInput: event.target.value }))}
                placeholder={t("playbooks.tagsPlaceholder")}
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Card size="sm" className="gap-0 overflow-hidden">
              <CardHeader className={cn("py-2", !isReadmeCollapsed && "border-b border-border")}>
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-mono text-muted-foreground">
                    {README_FILE_NAME}
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs"
                    aria-expanded={!isReadmeCollapsed}
                    onClick={() => handleToggleFileFold(README_FILE_NAME)}
                  >
                    {isReadmeCollapsed ? (
                      <ChevronRightIcon className="mr-1 size-3.5" />
                    ) : (
                      <ChevronDownIcon className="mr-1 size-3.5" />
                    )}
                    {isReadmeCollapsed ? t("playbooks.expandFile") : t("playbooks.collapseFile")}
                  </Button>
                </div>
              </CardHeader>
              {!isReadmeCollapsed && (
                <CardContent className="px-3 py-3">
                  <MarkdownEditor
                    value={draft.readme}
                    placeholder={t("playbooks.readmePlaceholder")}
                    className="min-h-[34rem] text-sm"
                    onChange={(nextValue) => setDraft((prev) => ({ ...prev, readme: nextValue }))}
                  />
                </CardContent>
              )}
            </Card>
          </div>

          {draft.scriptFiles.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <Label>{t("playbooks.scriptsLabel")}</Label>
              <div className="flex flex-wrap gap-1.5">
                {draft.scriptFiles.map((file) => (
                  <Badge key={file} asChild variant="outline" className="text-xs font-mono">
                    <button
                      type="button"
                      className="cursor-pointer"
                      onClick={() => handleScriptBadgeClick(file)}
                    >
                      {file}
                    </button>
                  </Badge>
                ))}
              </div>
              {draft.scriptCodeFiles.length > 0 && (
                <div className="mt-2 flex flex-col gap-3">
                  {draft.scriptCodeFiles.map((scriptFile) => {
                    const isScriptCollapsed = isFileCollapsed(scriptFile.path)
                    return (
                      <div
                        key={scriptFile.path}
                        ref={(node) => { scriptCardRefs.current[scriptFile.path] = node }}
                      >
                        <Card size="sm" className="gap-0 overflow-hidden">
                          <CardHeader className={cn("py-2", !isScriptCollapsed && "border-b border-border")}>
                            <div className="flex items-center justify-between gap-2">
                              <p className="text-xs font-mono text-muted-foreground">
                                {scriptFile.path}
                              </p>
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                className="h-7 px-2 text-xs"
                                aria-expanded={!isScriptCollapsed}
                                onClick={() => handleToggleFileFold(scriptFile.path)}
                              >
                                {isScriptCollapsed ? (
                                  <ChevronRightIcon className="mr-1 size-3.5" />
                                ) : (
                                  <ChevronDownIcon className="mr-1 size-3.5" />
                                )}
                                {isScriptCollapsed ? t("playbooks.expandFile") : t("playbooks.collapseFile")}
                              </Button>
                            </div>
                          </CardHeader>
                          {!isScriptCollapsed && (
                            <CardContent className="px-0">
                              <LiveSyntaxEditor
                                value={scriptFile.content}
                                filePath={scriptFile.path}
                                className="min-h-80"
                                onChange={(nextValue) => handleScriptContentChange(scriptFile.path, nextValue)}
                              />
                            </CardContent>
                          )}
                        </Card>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("playbooks.deletePlaybook")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("playbooks.deletePlaybookDescriptionInline", { name: originalName })}
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
