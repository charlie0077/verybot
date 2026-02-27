import { useState } from "react"
import { useTranslation } from "react-i18next"
import { LinkIcon, UnlinkIcon, FileTextIcon } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import {
  getCodexReasoningLevel,
  setCodexReasoningLevel,
  supportsCodexReasoningLevel,
  type CodexReasoningLevel,
} from "@/lib/model-spec"
import {
  CODEX_REASONING_LEVELS,
  getCodexReasoningDescriptionKey,
  getCodexReasoningLabelKey,
} from "@/lib/codex-reasoning-labels"
import { cn } from "@/lib/utils"
import { ModelPicker, type useModelCatalog, lookupContextWindow } from "@/components/model-picker"
import type { AgentConfig, PromptTemplate } from "./types"
import { DEFAULT_MAX_STEPS } from "./types"
import { useToolCatalog } from "./use-tool-catalog"

/* ------------------------------------------------------------------ */
/*  Shared agent form fields (used by orchestrator + worker panels)     */
/* ------------------------------------------------------------------ */

interface AgentFieldsProps {
  agent: AgentConfig
  catalog: ReturnType<typeof useModelCatalog>
  onUpdate: (updates: Partial<AgentConfig>) => void
  /** HTML id prefix for label/input association. */
  idPrefix: string
  nameLabel?: string
  namePlaceholder?: string
  identityPlaceholder?: string
  /** Show duplicate-name error text. */
  nameError?: string | null
  /** Available prompt templates for linking. */
  promptTemplates?: PromptTemplate[]
  /** Agent role — used to filter templates. */
  role?: "orchestrator" | "worker"
}

export function AgentFields({
  agent,
  catalog,
  onUpdate,
  idPrefix,
  nameLabel = "Name",
  namePlaceholder = "e.g. My Agent",
  identityPlaceholder = "You are a specialist in...",
  nameError,
  promptTemplates = [],
  role,
}: AgentFieldsProps) {
  const { t } = useTranslation()
  const toolOptions = useToolCatalog()
  const codexReasoning = getCodexReasoningLevel(agent.model) ?? "medium"
  const catalogCtx = lookupContextWindow(catalog, agent.model)
  const isCustomModel = catalogCtx === 0
  const [pickerOpen, setPickerOpen] = useState(false)

  const linkedTemplate = agent.templateId
    ? promptTemplates.find((pt) => pt.id === agent.templateId) ?? null
    : null

  function handleToolToggle(tool: string) {
    const tools = agent.tools.includes(tool)
      ? agent.tools.filter((t) => t !== tool)
      : [...agent.tools, tool]
    onUpdate({ tools })
  }

  function handleLinkTemplate(template: PromptTemplate) {
    onUpdate({ templateId: template.id, identity: "" })
    setPickerOpen(false)
  }

  function handleDetachTemplate() {
    // Copy template content to identity before detaching
    const content = linkedTemplate?.content ?? ""
    onUpdate({ templateId: null, identity: content })
  }

  // Filter templates by role if provided
  const filteredTemplates = role
    ? promptTemplates.filter((pt) => pt.role === role)
    : promptTemplates

  return (
    <>
      {/* Name + Model */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${idPrefix}-name`} className="text-xs font-medium text-foreground">
            {nameLabel}
          </Label>
          <Input
            id={`${idPrefix}-name`}
            value={agent.name}
            onChange={(e) => onUpdate({ name: e.target.value })}
            placeholder={namePlaceholder}
            className="text-sm"
          />
          {nameError && <p className="text-xs text-destructive">{nameError}</p>}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${idPrefix}-model`} className="text-xs font-medium text-foreground">
            {t("common.model")}
          </Label>
          <ModelPicker
            value={agent.model}
            onValueChange={(v) => {
              const updates: Partial<AgentConfig> = { model: v }
              if (lookupContextWindow(catalog, v) > 0) updates.contextWindow = 0
              onUpdate(updates)
            }}
          />
        </div>
        {supportsCodexReasoningLevel(agent.model) && (
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs font-medium text-foreground">
              {t("teams.codexReasoningLevel")}
            </Label>
            <Select
              value={codexReasoning}
              onValueChange={(v) => onUpdate({ model: setCodexReasoningLevel(agent.model, v as CodexReasoningLevel) })}
            >
              <SelectTrigger className="w-full">
                <SelectValue>{t(getCodexReasoningLabelKey("teams", codexReasoning))}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {CODEX_REASONING_LEVELS.map((level) => (
                  <SelectItem key={level} value={level}>
                    {t(getCodexReasoningLabelKey("teams", level))}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {t(getCodexReasoningDescriptionKey("teams", codexReasoning))}
            </p>
          </div>
        )}
      </div>

      {/* Context Window */}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${idPrefix}-ctx`} className="text-xs font-medium text-foreground">
          {t("teams.contextWindow")}
        </Label>
        <Input
          id={`${idPrefix}-ctx`}
          type="number"
          min={1024}
          disabled={!isCustomModel}
          value={isCustomModel ? String(agent.contextWindow || "") : String(catalogCtx)}
          onChange={(e) => onUpdate({ contextWindow: Number(e.target.value) || 0 })}
          placeholder="128000"
          className="text-sm"
        />
        <p className="text-xs text-muted-foreground">
          {isCustomModel
            ? t("teams.contextWindowCustom")
            : t("teams.contextWindowCatalog", { count: catalogCtx })}
        </p>
      </div>

      {/* Max Steps */}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${idPrefix}-steps`} className="text-xs font-medium text-foreground">
          {t("teams.maxSteps")}
        </Label>
        <Input
          id={`${idPrefix}-steps`}
          type="number"
          min={1}
          max={100}
          value={String(agent.maxSteps || "")}
          onChange={(e) => onUpdate({ maxSteps: Number(e.target.value) || 0 })}
          placeholder={String(DEFAULT_MAX_STEPS)}
          className="text-sm"
        />
        <p className="text-xs text-muted-foreground">
          {agent.maxSteps > 0 ? t("teams.maxStepsHint", { count: agent.maxSteps }) : t("teams.maxStepsHint_zero")}
        </p>
      </div>

      {/* Identity / Template */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <Label htmlFor={`${idPrefix}-identity`} className="text-xs font-medium text-foreground">
            {t("teams.identityLabel")}
          </Label>
          {linkedTemplate ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 gap-1 px-2 text-xs"
              onClick={handleDetachTemplate}
            >
              <UnlinkIcon className="size-3" />
              {t("promptTemplates.detach")}
            </Button>
          ) : filteredTemplates.length > 0 ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 gap-1 px-2 text-xs"
              onClick={() => setPickerOpen(true)}
            >
              <LinkIcon className="size-3" />
              {t("promptTemplates.useTemplate")}
            </Button>
          ) : null}
        </div>

        {linkedTemplate ? (
          <Card size="sm" interactive className="rounded-xl gap-0 py-0">
            <CardContent className="p-3">
              <div className="mb-2 flex items-center gap-2">
                <FileTextIcon className="size-3.5 text-primary" />
                <span className="text-sm font-medium text-foreground">{linkedTemplate.name}</span>
                {linkedTemplate.builtin && (
                  <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                    {t("promptTemplates.builtin")}
                  </Badge>
                )}
                <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                  {t("promptTemplates.linked")}
                </Badge>
              </div>
              {linkedTemplate.description && (
                <p className="mb-2 text-xs text-muted-foreground">{linkedTemplate.description}</p>
              )}
              <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap text-xs text-muted-foreground">
                {linkedTemplate.content}
              </pre>
            </CardContent>
          </Card>
        ) : (
          <Textarea
            id={`${idPrefix}-identity`}
            value={agent.identity}
            onChange={(e) => onUpdate({ identity: e.target.value })}
            rows={4}
            placeholder={identityPlaceholder}
            className="text-sm"
          />
        )}
      </div>

      {/* Tools */}
      <div className="flex flex-col gap-1.5">
        <Label className="text-xs font-medium text-foreground">
          {t("common.tools")} <span className="font-normal text-muted-foreground">{t("common.toolsHint")}</span>
        </Label>
        <div className="flex flex-wrap gap-1.5">
          {toolOptions.map((tool) => (
            <button
              key={tool}
              type="button"
              aria-pressed={agent.tools.includes(tool)}
              onClick={() => handleToolToggle(tool)}
              className={cn(
                "rounded-md border px-2.5 py-1 text-xs transition-colors",
                agent.tools.includes(tool)
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              {tool}
            </button>
          ))}
        </div>
      </div>

      {/* Template Picker Dialog */}
      <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
        <DialogContent className="max-h-[65vh] max-w-md grid-rows-[auto_minmax(0,1fr)]">
          <DialogHeader>
            <DialogTitle>{t("promptTemplates.pickTitle")}</DialogTitle>
            <DialogDescription>{t("promptTemplates.pickDescription")}</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 overflow-y-auto pr-1">
            {filteredTemplates.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">
                {t("promptTemplates.noTemplatesForRole")}
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {filteredTemplates.map((tmpl) => (
                  <Card
                    key={tmpl.id}
                    asChild
                    size="sm"
                    interactive
                    className="w-full rounded-xl gap-0 py-0"
                  >
                    <button
                      type="button"
                      onClick={() => handleLinkTemplate(tmpl)}
                      className="w-full text-left"
                    >
                      <CardContent className="flex items-start gap-3 p-3">
                        <FileTextIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                        <div className="min-w-0 flex flex-col gap-1">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-foreground">{tmpl.name}</span>
                            {tmpl.builtin && (
                              <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                                {t("promptTemplates.builtin")}
                              </Badge>
                            )}
                          </div>
                          {tmpl.description && (
                            <p className="line-clamp-2 text-xs text-muted-foreground">{tmpl.description}</p>
                          )}
                        </div>
                      </CardContent>
                    </button>
                  </Card>
                ))}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
