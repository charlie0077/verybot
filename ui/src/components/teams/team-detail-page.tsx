import { useState, useEffect } from "react"
import { useTranslation, Trans } from "react-i18next"
import { useParams, useNavigate, Link } from "react-router"
import { useMediaQuery } from "usehooks-ts"
import {
  ArrowLeftIcon,
  ChevronLeftIcon,
  PlusIcon,
  SaveIcon,
  CrownIcon,
  BotIcon,
  BrainIcon,
  ListChecksIcon,
  LoaderIcon,
  CheckIcon,
  AlertCircleIcon,
  Trash2Icon,
  SettingsIcon,
  XIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
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
import { cn, createClientId } from "@/lib/utils"
import { useModelCatalog } from "@/components/model-picker"
import { useTeamsContext } from "./teams-layout"
import { AgentFields } from "./agent-fields"
import type { AgentConfig, SaveState, TeamConfig, PromptTemplate } from "./types"
import {
  DEFAULT_WORKER_TIMEOUT_S,
  EMPTY_AGENT,
  TEAM_COLORS,
  buildInitialDraft,
} from "./types"
import { TeamMemoryPanel } from "./team-memory-panel"
import { TaskSettingsPanel } from "./task-settings-panel"

/* ------------------------------------------------------------------ */
/*  Panel selection: orchestrator or a worker by index                  */
/* ------------------------------------------------------------------ */

type ActivePanel = "orchestrator" | "settings" | "workers" | "task" | "memory" | number
type TeamMobilePane = "sections" | "panel"
const TEAM_DETAIL_DESKTOP_BREAKPOINT_QUERY = "(min-width: 1024px)"

/* ------------------------------------------------------------------ */
/*  Team detail page — /teams/new and /teams/:teamId                   */
/* ------------------------------------------------------------------ */

export function TeamDetailPage() {
  const { t } = useTranslation()
  const { teamId } = useParams<{ teamId: string }>()
  const navigate = useNavigate()
  const isDesktop = useMediaQuery(TEAM_DETAIL_DESKTOP_BREAKPOINT_QUERY)
  const { teams, promptTemplates, globalModelConfig, loading, saveState, error, saveTeam, deleteTeam } = useTeamsContext()
  const catalog = useModelCatalog()

  const isNew = !teamId || teamId === "new"
  const existing = isNew ? null : teams.find((t) => t.id === teamId)

  const [draft, setDraft] = useState<TeamConfig>(() => buildInitialDraft(existing, teams, globalModelConfig))
  const [teamNameError, setTeamNameError] = useState<string | null>(null)
  const [activePanel, setActivePanel] = useState<ActivePanel>("settings")
  const [mobilePane, setMobilePane] = useState<TeamMobilePane>("sections")
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)

  // Reset draft when teamId changes
  useEffect(() => {
    const target = isNew ? null : teams.find((t) => t.id === teamId)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDraft(buildInitialDraft(target, teams, globalModelConfig))
    setTeamNameError(null)
    setActivePanel("settings")
    setMobilePane("sections")
    setDeleteDialogOpen(false)
  }, [teamId, isNew, teams, globalModelConfig])

  // Redirect to list if editing a non-existent team (after loading)
  useEffect(() => {
    if (!isNew && !loading && teams.length > 0 && !existing) {
      void navigate("/teams", { replace: true })
    }
  }, [isNew, loading, teams, existing, navigate])

  function handleTeamNameChange(val: string) {
    setDraft((prev) => ({ ...prev, name: val }))
    const trimmed = val.trim()
    if (!trimmed) {
      setTeamNameError(t("teams.teamNameRequired"))
    } else if (teams.some((tm) => tm.name.trim() === trimmed && tm.id !== draft.id)) {
      setTeamNameError(t("teams.teamNameDuplicate"))
    } else {
      setTeamNameError(null)
    }
  }

  function handleColorChange(color: string) {
    setDraft((prev) => ({ ...prev, color }))
  }

  function updateOrchestrator(updates: Partial<AgentConfig>) {
    setDraft((prev) => ({
      ...prev,
      orchestrator: { ...prev.orchestrator, ...updates },
    }))
  }

  function updateWorker(index: number, updated: AgentConfig) {
    setDraft((prev) => {
      const workers = [...prev.workers]
      workers[index] = updated
      return { ...prev, workers }
    })
  }

  function handleSelectPanel(panel: ActivePanel) {
    setActivePanel(panel)
    if (!isDesktop) setMobilePane("panel")
  }

  function addWorker() {
    const newIndex = draft.workers.length
    const key = createClientId()
    setDraft((prev) => ({
      ...prev,
      workers: [...prev.workers, { ...EMPTY_AGENT, id: createClientId(), _key: key }],
    }))
    setActivePanel(newIndex)
    if (!isDesktop) setMobilePane("panel")
  }

  function removeWorker(index: number) {
    setDraft((prev) => ({
      ...prev,
      workers: prev.workers.filter((_, i) => i !== index),
    }))
    setActivePanel("workers")
  }

  /* Validation */
  const workerNames = draft.workers.map((w) => w.name.trim())
  const allAgentNames = [draft.orchestrator.name.trim(), ...workerNames].filter(Boolean)
  const hasDuplicateAgentNames = new Set(allAgentNames).size !== allAgentNames.length
  const orchNameConflict = draft.orchestrator.name.trim() !== "" && workerNames.includes(draft.orchestrator.name.trim())
  const hasModel = (a: AgentConfig) => a.model.trim().length > 0
  const isValid =
    draft.name.trim().length > 0 &&
    !teamNameError &&
    draft.orchestrator.name.length > 0 &&
    hasModel(draft.orchestrator) &&
    !draft.workers.some((w) => !w.name || !hasModel(w)) &&
    !hasDuplicateAgentNames

  async function handleSave() {
    if (!isValid || saveState === "saving") return
    const ok = await saveTeam(draft)
    if (!ok) return
    if (isNew) void navigate(`/teams/${draft.id}`, { replace: true })
  }

  async function handleDeleteTeam() {
    if (isNew || saveState === "saving") return
    const ok = await deleteTeam(draft.id)
    setDeleteDialogOpen(false)
    if (ok) void navigate("/teams")
  }

  const activePanelTitle = typeof activePanel === "number"
    ? (draft.workers[activePanel]?.name || t("teams.worker", { index: activePanel + 1 }))
    : activePanel === "settings"
      ? t("teams.info")
      : activePanel === "orchestrator"
        ? t("teams.orchestrator")
        : activePanel === "workers"
          ? `${t("teams.workers")} (${draft.workers.length})`
          : activePanel === "task"
            ? t("teams.taskSettings")
            : t("teams.memory")

  const activePanelContent = activePanel === "orchestrator" ? (
    <OrchestratorPanel
      agent={draft.orchestrator}
      catalog={catalog}
      onUpdate={updateOrchestrator}
      nameError={orchNameConflict ? t("teams.nameConflict") : null}
      promptTemplates={promptTemplates}
    />
  ) : activePanel === "settings" ? (
    <TeamSettingsPanel
      name={draft.name}
      color={draft.color}
      workspace={draft.workspace}
      variables={draft.variables}
      teamNameError={teamNameError}
      onTeamNameChange={handleTeamNameChange}
      onColorChange={handleColorChange}
      onWorkspaceChange={(workspace) => setDraft((prev) => ({ ...prev, workspace }))}
      onVariablesChange={(variables) => setDraft((prev) => ({ ...prev, variables }))}
      showDangerZone={!isNew}
      onDeleteTeam={!isNew ? () => setDeleteDialogOpen(true) : undefined}
    />
  ) : activePanel === "workers" ? (
    <WorkerListPanel
      workers={draft.workers}
      onSelectWorker={(index) => handleSelectPanel(index)}
      onAddWorker={addWorker}
    />
  ) : activePanel === "task" ? (
    <TaskSettingsPanel
      draft={draft}
      onDraftChange={setDraft}
    />
  ) : activePanel === "memory" ? (
    <TeamMemoryPanel teamId={draft.id} />
  ) : typeof activePanel === "number" && draft.workers[activePanel] ? (
    <WorkerPanel
      worker={draft.workers[activePanel]}
      index={activePanel}
      allAgentNames={allAgentNames}
      catalog={catalog}
      onChange={(updated) => updateWorker(activePanel, updated)}
      onDelete={() => removeWorker(activePanel)}
      promptTemplates={promptTemplates}
    />
  ) : null

  if (loading) {
    return (
      <div data-slot="teams-detail-page" className="flex h-full items-center justify-center">
        <LoaderIcon className="size-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div data-slot="teams-detail-page" className="flex h-full flex-col">
      {isDesktop ? (
        <TeamDetailHeader
          title={isNew ? t("teams.newTeam") : (draft.name || draft.id)}
          saveState={saveState}
          error={error}
          isValid={isValid}
          isNew={isNew}
          canDelete={!isNew}
          onDelete={() => setDeleteDialogOpen(true)}
          onSave={handleSave}
        />
      ) : (
        <TeamDetailMobileHeader
          teamTitle={isNew ? t("teams.newTeam") : (draft.name || draft.id)}
          panelTitle={activePanelTitle}
          saveState={saveState}
          error={error}
          isValid={isValid}
          isNew={isNew}
          mobilePane={mobilePane}
          onBackToSections={() => setMobilePane("sections")}
          onSave={handleSave}
        />
      )}

      {isDesktop ? (
        <div className="flex flex-1 overflow-hidden">
          <TeamSidebar
            draft={draft}
            activePanel={activePanel}
            isNew={isNew}
            onSelectPanel={handleSelectPanel}
          />

          <div className="flex-1 overflow-y-auto px-8 py-6">
            <div className="mx-auto max-w-xl">
              {activePanelContent}
            </div>
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-hidden">
          {mobilePane === "sections" ? (
            <TeamSidebar
              draft={draft}
              activePanel={activePanel}
              isNew={isNew}
              onSelectPanel={handleSelectPanel}
              compact
            />
          ) : (
            <div className="h-full overflow-y-auto px-3 py-4 sm:px-4">
              <div className="mx-auto max-w-xl">
                {activePanelContent}
              </div>
            </div>
          )}
        </div>
      )}

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("teams.deleteTeam")}</AlertDialogTitle>
            <AlertDialogDescription>
              <Trans
                i18nKey="teams.deleteTeamDescription"
                values={{ name: draft.name || draft.id }}
                components={{ strong: <strong /> }}
              />
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => { void handleDeleteTeam() }}>
              {t("common.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Header                                                             */
/* ------------------------------------------------------------------ */

interface TeamDetailHeaderProps {
  title: string
  saveState: SaveState
  error: string | null
  isValid: boolean
  isNew: boolean
  canDelete: boolean
  onDelete: () => void
  onSave: () => void
}

function TeamDetailHeader({
  title,
  saveState,
  error,
  isValid,
  isNew,
  canDelete,
  onDelete,
  onSave,
}: TeamDetailHeaderProps) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center justify-between border-b border-border px-6 py-2">
      <div className="flex items-center gap-3">
        <Link
          to="/teams"
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeftIcon className="size-4" />
          {t("teams.title")}
        </Link>
        <span className="text-muted-foreground">/</span>
        <h1 className="text-lg font-semibold text-foreground">{title}</h1>
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
        {canDelete && (
          <Button size="sm" variant="destructive" disabled={saveState === "saving"} onClick={onDelete}>
            <Trash2Icon className="mr-1.5 size-3.5" />
            {t("common.delete")}
          </Button>
        )}
        <Button size="sm" variant="outline" asChild>
          <Link to="/teams">{t("common.cancel")}</Link>
        </Button>
        <Button size="sm" disabled={!isValid || saveState === "saving"} onClick={onSave}>
          <SaveIcon className="mr-1.5 size-3.5" />
          {isNew ? t("teams.createTeam") : t("common.save")}
        </Button>
      </div>
    </div>
  )
}

interface TeamDetailMobileHeaderProps {
  teamTitle: string
  panelTitle: string
  saveState: SaveState
  error: string | null
  isValid: boolean
  isNew: boolean
  mobilePane: TeamMobilePane
  onBackToSections: () => void
  onSave: () => void
}

function TeamDetailMobileHeader({
  teamTitle,
  panelTitle,
  saveState,
  error,
  isValid,
  isNew,
  mobilePane,
  onBackToSections,
  onSave,
}: TeamDetailMobileHeaderProps) {
  const { t } = useTranslation()

  return (
    <div className="border-b border-border">
      <div className="flex items-center justify-between gap-2 px-3 py-2 sm:px-4">
        {mobilePane === "panel" ? (
          <Button type="button" variant="ghost" size="sm" onClick={onBackToSections}>
            <ChevronLeftIcon className="size-4" />
            {t("teams.sections")}
          </Button>
        ) : (
          <Button type="button" variant="ghost" size="sm" asChild>
            <Link to="/teams">
              <ArrowLeftIcon className="size-4" />
              {t("teams.title")}
            </Link>
          </Button>
        )}

        <div className="min-w-0 flex-1 text-center">
          <h1 className="truncate text-sm font-semibold text-foreground">
            {mobilePane === "sections" ? teamTitle : panelTitle}
          </h1>
          {saveState === "saved" && (
            <span className="text-xs text-success">{t("common.saved")}</span>
          )}
        </div>

        <Button size="sm" disabled={!isValid || saveState === "saving"} onClick={onSave}>
          {saveState === "saving" ? <LoaderIcon className="size-3.5 animate-spin" /> : <SaveIcon className="size-3.5" />}
          <span>{isNew ? t("teams.createTeam") : t("common.save")}</span>
        </Button>
      </div>
      {error && (
        <div className="border-t border-border px-3 py-1.5 text-xs text-destructive sm:px-4">
          {error}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Sidebar                                                            */
/* ------------------------------------------------------------------ */

interface TeamSidebarProps {
  draft: TeamConfig
  activePanel: ActivePanel
  isNew: boolean
  onSelectPanel: (panel: ActivePanel) => void
  compact?: boolean
}

function TeamSidebar({
  draft,
  activePanel,
  isNew,
  onSelectPanel,
  compact = false,
}: TeamSidebarProps) {
  const { t } = useTranslation()
  return (
    <div
      className={cn(
        "flex min-h-0 flex-col bg-sidebar-secondary",
        compact ? "h-full" : "w-72 shrink-0 border-r border-border",
      )}
    >
      <nav className={cn("flex flex-1 flex-col overflow-y-auto", compact ? "p-3" : "p-2")}>
        <p className="px-2 pb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t("teams.sections")}
        </p>

        <div className="flex flex-col gap-0.5">
          <button
            type="button"
            aria-current={activePanel === "settings" ? "true" : undefined}
            onClick={() => onSelectPanel("settings")}
            className={cn(
              "flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors",
              activePanel === "settings"
                ? "bg-sidebar-accent/10 text-sidebar-foreground font-medium"
                : "text-muted-foreground hover:text-sidebar-foreground hover:bg-sidebar-accent/10",
            )}
          >
            <SettingsIcon className="size-3.5 text-chart-2" />
            <span className="truncate">{t("teams.info")}</span>
          </button>

          <button
            type="button"
            aria-current={activePanel === "orchestrator" ? "true" : undefined}
            onClick={() => onSelectPanel("orchestrator")}
            className={cn(
              "flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors",
              activePanel === "orchestrator"
                ? "bg-sidebar-accent/10 text-sidebar-foreground font-medium"
                : "text-muted-foreground hover:text-sidebar-foreground hover:bg-sidebar-accent/10",
            )}
          >
            <CrownIcon className="size-3.5 text-chart-4" />
            <span className="truncate">{t("teams.orchestrator")}</span>
          </button>

          <button
            type="button"
            aria-current={activePanel === "workers" || typeof activePanel === "number" ? "true" : undefined}
            onClick={() => onSelectPanel("workers")}
            className={cn(
              "flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors",
              activePanel === "workers" || typeof activePanel === "number"
                ? "bg-sidebar-accent/10 text-sidebar-foreground font-medium"
                : "text-muted-foreground hover:text-sidebar-foreground hover:bg-sidebar-accent/10",
            )}
          >
            <span className="flex min-w-0 items-center gap-2">
              <BotIcon className="size-3.5 text-chart-3" />
              <span className="truncate">{t("teams.workers")}</span>
            </span>
            <span className="text-xs tabular-nums text-muted-foreground">({draft.workers.length})</span>
          </button>

          <button
            type="button"
            aria-current={activePanel === "task" ? "true" : undefined}
            onClick={() => onSelectPanel("task")}
            className={cn(
              "flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors",
              activePanel === "task"
                ? "bg-sidebar-accent/10 text-sidebar-foreground font-medium"
                : "text-muted-foreground hover:text-sidebar-foreground hover:bg-sidebar-accent/10",
            )}
          >
            <ListChecksIcon className="size-3.5 text-chart-1" />
            <span className="truncate">{t("teams.taskSettings")}</span>
          </button>

          {draft.id && !isNew && (
            <button
              type="button"
              aria-current={activePanel === "memory" ? "true" : undefined}
              onClick={() => onSelectPanel("memory")}
              className={cn(
                "flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors",
                activePanel === "memory"
                  ? "bg-sidebar-accent/10 text-sidebar-foreground font-medium"
                  : "text-muted-foreground hover:text-sidebar-foreground hover:bg-sidebar-accent/10",
              )}
            >
              <BrainIcon className="size-3.5 text-chart-5" />
              <span className="truncate">{t("teams.memory")}</span>
            </button>
          )}
        </div>
      </nav>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Orchestrator panel                                                 */
/* ------------------------------------------------------------------ */

interface OrchestratorPanelProps {
  agent: AgentConfig
  catalog: ReturnType<typeof useModelCatalog>
  onUpdate: (updates: Partial<AgentConfig>) => void
  nameError?: string | null
  promptTemplates?: PromptTemplate[]
}

function OrchestratorPanel({ agent, catalog, onUpdate, nameError, promptTemplates }: OrchestratorPanelProps) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-2">
        <CrownIcon className="size-4 text-chart-4" />
        <h2 className="text-base font-semibold text-foreground">{t("teams.orchestrator")}</h2>
      </div>
      <AgentFields
        agent={agent}
        catalog={catalog}
        onUpdate={onUpdate}
        idPrefix="orch"
        nameLabel={t("teams.orchestratorName")}
        namePlaceholder={t("teams.orchestratorNamePlaceholder")}
        identityPlaceholder={t("teams.orchestratorIdentityPlaceholder")}
        nameError={nameError}
        promptTemplates={promptTemplates}
        role="orchestrator"
      />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Workers list panel                                                 */
/* ------------------------------------------------------------------ */

interface WorkerListPanelProps {
  workers: AgentConfig[]
  onSelectWorker: (index: number) => void
  onAddWorker: () => void
}

function WorkerListPanel({ workers, onSelectWorker, onAddWorker }: WorkerListPanelProps) {
  const { t } = useTranslation()

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BotIcon className="size-4 text-chart-3" />
          <h2 className="text-base font-semibold text-foreground">
            {t("teams.workers")} <span className="tabular-nums text-muted-foreground">({workers.length})</span>
          </h2>
        </div>
        <Button size="sm" variant="outline" onClick={onAddWorker}>
          <PlusIcon className="mr-1.5 size-3.5" />
          {t("teams.addWorker")}
        </Button>
      </div>

      {workers.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
          {t("teams.noWorkersMessage")}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {workers.map((worker, index) => (
            <button
              key={worker._key ?? index}
              type="button"
              onClick={() => onSelectWorker(index)}
              className="flex items-center justify-between rounded-lg border border-border bg-card/30 px-3 py-2.5 text-left transition-colors hover:bg-muted/40"
            >
              <span className="flex min-w-0 items-center gap-2">
                <BotIcon className="size-3.5 shrink-0 text-chart-3" />
                <span className="truncate text-sm text-foreground">
                  {worker.name || t("teams.worker", { index: index + 1 })}
                </span>
              </span>
              <ChevronLeftIcon className="size-4 rotate-180 text-muted-foreground" />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Worker panel                                                       */
/* ------------------------------------------------------------------ */

interface WorkerPanelProps {
  worker: AgentConfig
  index: number
  allAgentNames: string[]
  catalog: ReturnType<typeof useModelCatalog>
  onChange: (updated: AgentConfig) => void
  onDelete: () => void
  promptTemplates?: PromptTemplate[]
}

function WorkerPanel({ worker, index, allAgentNames, catalog, onChange, onDelete, promptTemplates }: WorkerPanelProps) {
  const { t } = useTranslation()
  const trimmedName = worker.name.trim()
  const nameDuplicate = trimmedName !== "" && allAgentNames.filter((n) => n === trimmedName).length > 1

  function handleUpdate(updates: Partial<AgentConfig>) {
    onChange({ ...worker, ...updates })
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BotIcon className="size-4 text-chart-3" />
          <h2 className="text-base font-semibold text-foreground">
            {t("teams.worker", { index: index + 1 })}{worker.name ? `: ${worker.name}` : ""}
          </h2>
        </div>
        <Button size="sm" variant="ghost" onClick={onDelete} aria-label={`Remove ${worker.name || `Worker ${index + 1}`}`}>
          <Trash2Icon className="mr-1.5 size-3.5 text-destructive" />
          <span className="text-destructive">{t("common.remove")}</span>
        </Button>
      </div>

      <AgentFields
        agent={worker}
        catalog={catalog}
        onUpdate={handleUpdate}
        idPrefix={`worker-${index}`}
        nameLabel={t("teams.workerName")}
        namePlaceholder={t("teams.workerNamePlaceholder")}
        identityPlaceholder={t("teams.workerIdentityPlaceholder")}
        nameError={nameDuplicate ? t("teams.duplicateName") : null}
        promptTemplates={promptTemplates}
        role="worker"
      />

      {/* Worker-specific: timeout */}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`worker-${index}-timeout`} className="text-xs font-medium text-foreground">
          {t("teams.timeout")}
        </Label>
        <Input
          id={`worker-${index}-timeout`}
          type="number"
          min={10}
          value={worker.timeout}
          onChange={(e) =>
            onChange({ ...worker, timeout: Number(e.target.value) || DEFAULT_WORKER_TIMEOUT_S })
          }
          className="h-8 text-sm"
        />
      </div>

      {/* Concurrency */}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`worker-${index}-concurrency`} className="text-xs font-medium text-foreground">
          {t("teams.concurrency")}
        </Label>
        <Input
          id={`worker-${index}-concurrency`}
          type="number"
          min={1}
          max={10}
          value={worker.concurrency ?? 1}
          onChange={(e) =>
            onChange({ ...worker, concurrency: Math.max(1, Number(e.target.value) || 1) })
          }
          className="h-8 text-sm w-20"
        />
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Settings panel (workspace + variables)                              */
/* ------------------------------------------------------------------ */

const VARIABLE_KEY_RE = /^\w+$/

interface TeamSettingsPanelProps {
  name: string
  color: string
  workspace: string
  variables: Record<string, string>
  teamNameError: string | null
  onTeamNameChange: (val: string) => void
  onColorChange: (color: string) => void
  onWorkspaceChange: (workspace: string) => void
  onVariablesChange: (variables: Record<string, string>) => void
  showDangerZone?: boolean
  onDeleteTeam?: () => void
}

function TeamSettingsPanel({
  name, color, workspace, variables, teamNameError,
  onTeamNameChange, onColorChange, onWorkspaceChange, onVariablesChange,
  showDangerZone = false,
  onDeleteTeam,
}: TeamSettingsPanelProps) {
  const { t } = useTranslation()

  // Maintain stable identity for each variable row to avoid React key issues on rename.
  const [varRows, setVarRows] = useState(() =>
    Object.entries(variables).map(([key, value]) => ({ _id: createClientId(), key, value })),
  )

  function commitRows(rows: typeof varRows) {
    setVarRows(rows)
    const record: Record<string, string> = {}
    for (const row of rows) {
      if (row.key) record[row.key] = row.value
    }
    onVariablesChange(record)
  }

  function updateRow(id: string, key: string, value: string) {
    commitRows(varRows.map((r) => (r._id === id ? { ...r, key, value } : r)))
  }

  function removeRow(id: string) {
    commitRows(varRows.filter((r) => r._id !== id))
  }

  function addRow() {
    commitRows([...varRows, { _id: createClientId(), key: "", value: "" }])
  }

  const keyCount = new Map<string, number>()
  for (const r of varRows) {
    if (r.key) keyCount.set(r.key, (keyCount.get(r.key) ?? 0) + 1)
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-2">
        <SettingsIcon className="size-4 text-chart-2" />
        <h2 className="text-base font-semibold text-foreground">{t("teams.info")}</h2>
      </div>

      {/* Team Name */}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="team-name" className="text-xs font-medium text-foreground">{t("teams.teamName")}</Label>
        <Input
          id="team-name"
          value={name}
          onChange={(e) => onTeamNameChange(e.target.value)}
          placeholder={t("teams.teamNamePlaceholder")}
          className="h-8 text-sm"
        />
        {teamNameError && <p className="text-xs text-destructive">{teamNameError}</p>}
      </div>

      {/* Team Color */}
      <div className="flex flex-col gap-1.5">
        <Label className="text-xs font-medium text-foreground">{t("teams.teamColor")}</Label>
        <div className="flex flex-wrap gap-2">
          {TEAM_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={`Select color ${c}`}
              onClick={() => onColorChange(c)}
              className={cn(
                "size-7 rounded-full border-2 transition-all",
                color === c
                  ? "scale-110 border-transparent shadow-sm"
                  : "border-transparent hover:scale-110 hover:ring-1 hover:ring-border",
              )}
              style={{ backgroundColor: c }}
            >
              {color === c && (
                <CheckIcon className="size-3.5 mx-auto text-white drop-shadow-sm" />
              )}
            </button>
          ))}
        </div>
      </div>

      <Separator />

      {/* Workspace */}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="team-workspace" className="text-xs font-medium text-foreground">
          {t("teams.workspace")}
        </Label>
        <Input
          id="team-workspace"
          value={workspace}
          onChange={(e) => onWorkspaceChange(e.target.value)}
          placeholder={t("teams.workspacePlaceholder")}
          className="h-8 text-sm font-mono"
        />
        <p className="text-xs text-muted-foreground">{t("teams.workspaceHint")}</p>
      </div>

      <Separator />

      {/* Variables */}
      <div className="flex flex-col gap-3">
        <Label className="text-xs font-medium text-foreground">{t("teams.variables")}</Label>

        {varRows.map((row) => {
          const isDuplicate = row.key !== "" && (keyCount.get(row.key) ?? 0) > 1
          const isInvalidKey = row.key !== "" && !VARIABLE_KEY_RE.test(row.key)
          return (
            <div key={row._id} className="flex items-start gap-2">
              <div className="flex flex-1 flex-col gap-1">
                <Input
                  value={row.key}
                  onChange={(e) => updateRow(row._id, e.target.value, row.value)}
                  placeholder={t("teams.variableKeyPlaceholder")}
                  className="h-8 text-sm font-mono"
                  aria-label={t("teams.variableKey")}
                />
                {isDuplicate && <p className="text-xs text-destructive">{t("teams.variableKeyDuplicate")}</p>}
                {isInvalidKey && <p className="text-xs text-destructive">{t("teams.variableKeyInvalid")}</p>}
              </div>
              <div className="flex-1">
                <Input
                  value={row.value}
                  onChange={(e) => updateRow(row._id, row.key, e.target.value)}
                  placeholder={t("teams.variableValuePlaceholder")}
                  className="h-8 text-sm"
                  aria-label={t("teams.variableValue")}
                />
              </div>
              <Button
                size="icon"
                variant="ghost"
                className="size-8 shrink-0"
                onClick={() => removeRow(row._id)}
                aria-label={`Remove variable ${row.key}`}
              >
                <XIcon className="size-3.5 text-muted-foreground" />
              </Button>
            </div>
          )
        })}

        <Button size="sm" variant="outline" onClick={addRow} className="w-fit">
          <PlusIcon className="mr-1.5 size-3" />
          {t("teams.addVariable")}
        </Button>
      </div>

      {showDangerZone && onDeleteTeam && (
        <>
          <Separator />
          <div className="flex flex-col gap-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t("teams.deleteTeam")}
            </p>
            <Button
              size="sm"
              variant="destructive"
              className="w-fit"
              onClick={onDeleteTeam}
            >
              <Trash2Icon className="mr-1.5 size-3.5" />
              {t("common.delete")}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
