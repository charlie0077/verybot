import { useState, useEffect } from "react"
import { useTranslation } from "react-i18next"
import { useParams, useNavigate, Link } from "react-router"
import {
  ArrowLeftIcon,
  SaveIcon,
  CopyPlusIcon,
  LoaderIcon,
  CheckIcon,
  AlertCircleIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { useGatewayContext } from "@/contexts/gateway-context"
import { usePromptTemplatesContext } from "./prompt-templates-layout"
import type { PromptTemplate } from "@/components/teams/types"

/* ------------------------------------------------------------------ */
/*  Prompt template detail — /prompt-templates/new and /:id            */
/* ------------------------------------------------------------------ */

interface TemplateDraft {
  id: string
  name: string
  description: string
  role: PromptTemplate["role"]
  content: string
  builtin: boolean
}

const EMPTY_DRAFT: TemplateDraft = {
  id: "",
  name: "",
  description: "",
  role: "worker",
  content: "",
  builtin: false,
}

export function PromptTemplateDetailPage() {
  const { t } = useTranslation()
  const { id: paramId } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { rpc } = useGatewayContext()
  const { templates, loading, saveState, error, saveTemplate, forkTemplate } = usePromptTemplatesContext()

  const isNew = !paramId || paramId === "new"

  const [draft, setDraft] = useState<TemplateDraft>({ ...EMPTY_DRAFT })
  const [nameError, setNameError] = useState<string | null>(null)
  const [fetching, setFetching] = useState(!isNew)

  // Load full template detail for edit mode
  useEffect(() => {
    if (isNew) {
      setDraft({ ...EMPTY_DRAFT })
      setFetching(false)
      return
    }

    let cancelled = false
    setFetching(true)

    rpc("promptTemplates.get", { id: paramId })
      .then((result) => {
        if (cancelled) return
        const tpl = (result as { promptTemplate?: PromptTemplate })?.promptTemplate
        if (tpl) {
          setDraft({
            id: tpl.id,
            name: tpl.name,
            description: tpl.description,
            role: tpl.role,
            content: tpl.content,
            builtin: tpl.builtin,
          })
        } else {
          void navigate("/prompt-templates", { replace: true })
        }
      })
      .catch(() => {
        if (!cancelled) void navigate("/prompt-templates", { replace: true })
      })
      .finally(() => {
        if (!cancelled) setFetching(false)
      })

    return () => { cancelled = true }
  }, [paramId, isNew, rpc, navigate])

  // Redirect if editing a non-existent template (after list loaded)
  useEffect(() => {
    if (!isNew && !loading && templates.length > 0 && !fetching) {
      const exists = templates.some((tpl) => tpl.id === paramId)
      if (!exists && draft.name === "") {
        void navigate("/prompt-templates", { replace: true })
      }
    }
  }, [isNew, loading, templates, paramId, fetching, draft.name, navigate])

  function handleNameChange(val: string) {
    setDraft((prev) => ({ ...prev, name: val }))
    const trimmed = val.trim()
    if (!trimmed) {
      setNameError(t("promptTemplates.nameRequired"))
    } else if (
      templates.some(
        (tpl) => tpl.name.toLowerCase() === trimmed.toLowerCase() && tpl.id !== draft.id,
      )
    ) {
      setNameError(t("promptTemplates.nameDuplicate"))
    } else {
      setNameError(null)
    }
  }

  async function handleSave() {
    if (!draft.name.trim()) {
      setNameError(t("promptTemplates.nameRequired"))
      return
    }
    if (!draft.content.trim()) return
    if (nameError) return

    const ok = await saveTemplate({
      ...(draft.id ? { id: draft.id } : {}),
      name: draft.name.trim(),
      description: draft.description.trim(),
      role: draft.role,
      content: draft.content,
    })
    if (ok) void navigate("/prompt-templates")
  }

  async function handleFork() {
    if (!draft.id) return
    const forked = await forkTemplate(draft.id)
    if (!forked) return
    void navigate(`/prompt-templates/${encodeURIComponent(forked.id)}`)
  }

  const canSave = !draft.builtin && draft.name.trim().length > 0 && draft.content.trim().length > 0 && !nameError

  if (fetching) {
    return (
      <div className="flex h-full items-center justify-center">
        <LoaderIcon className="size-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div data-slot="prompt-template-detail-page" className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-6 py-2">
        <div className="flex items-center gap-3">
          <Button size="icon" variant="ghost" asChild>
            <Link to="/prompt-templates">
              <ArrowLeftIcon className="size-4" />
            </Link>
          </Button>
          <h1 className="text-lg font-semibold text-foreground">
            {isNew ? t("promptTemplates.newTemplate") : draft.name}
          </h1>
          {draft.builtin && (
            <Badge variant="secondary" className="text-xs">
              {t("promptTemplates.builtin")}
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
          <Button size="sm" variant="outline" asChild>
            <Link to="/prompt-templates">{t("common.cancel")}</Link>
          </Button>
          {draft.builtin && (
            <Button size="sm" disabled={saveState === "saving"} onClick={handleFork}>
              <CopyPlusIcon className="mr-1.5 size-3.5" />
              {t("promptTemplates.forkTemplate")}
            </Button>
          )}
          {!draft.builtin && (
            <Button size="sm" disabled={!canSave || saveState === "saving"} onClick={handleSave}>
              <SaveIcon className="mr-1.5 size-3.5" />
              {t("common.save")}
            </Button>
          )}
        </div>
      </div>

      {/* Form */}
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto flex max-w-2xl flex-col gap-6">
          {draft.builtin && (
            <p className="text-sm text-muted-foreground">{t("promptTemplates.builtinReadonly")}</p>
          )}

          {/* Name */}
          <div className="flex flex-col gap-1.5">
            <Label>{t("common.name")}</Label>
            <Input
              value={draft.name}
              onChange={(e) => handleNameChange(e.target.value)}
              placeholder={t("promptTemplates.namePlaceholder")}
              disabled={draft.builtin}
            />
            {nameError && (
              <p className="mt-1 text-xs text-destructive">{nameError}</p>
            )}
          </div>

          {/* Description */}
          <div className="flex flex-col gap-1.5">
            <Label>{t("common.description")}</Label>
            <Input
              value={draft.description}
              onChange={(e) =>
                setDraft((prev) => ({ ...prev, description: e.target.value }))
              }
              placeholder={t("promptTemplates.descriptionPlaceholder")}
              disabled={draft.builtin}
            />
          </div>

          {/* Role */}
          <div className="flex flex-col gap-1.5">
            <Label>{t("promptTemplates.roleLabel")}</Label>
            <Select
              value={draft.role}
              onValueChange={(val) =>
                setDraft((prev) => ({ ...prev, role: val as "orchestrator" | "worker" }))
              }
              disabled={draft.builtin}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="orchestrator">{t("teams.orchestrator")}</SelectItem>
                <SelectItem value="worker">{t("promptTemplates.worker")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Content */}
          <div className="flex flex-col gap-1.5">
            <Label>{t("promptTemplates.contentLabel")}</Label>
            <Textarea
              value={draft.content}
              onChange={(e) =>
                setDraft((prev) => ({ ...prev, content: e.target.value }))
              }
              placeholder={t("promptTemplates.contentPlaceholder")}
              className="min-h-64 font-mono text-sm"
              disabled={draft.builtin}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
