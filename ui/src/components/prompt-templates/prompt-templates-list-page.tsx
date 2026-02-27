import { useState } from "react"
import { useTranslation, Trans } from "react-i18next"
import { Link, useNavigate } from "react-router"
import {
  PlusIcon,
  CopyPlusIcon,
  FileTextIcon,
  Trash2Icon,
  CheckIcon,
  LoaderIcon,
  AlertCircleIcon,
  SearchIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import {
  Card,
  CardHeader,
  CardTitle,
  CardAction,
} from "@/components/ui/card"
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
import { usePromptTemplatesContext } from "./prompt-templates-layout"

/* ------------------------------------------------------------------ */
/*  Prompt templates list page — /prompt-templates                     */
/* ------------------------------------------------------------------ */

export function PromptTemplatesListPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { templates, loading, saveState, error, forkTemplate, deleteTemplate } = usePromptTemplatesContext()
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [search, setSearch] = useState("")

  const filtered = search
    ? templates.filter(
        (tpl) =>
          tpl.name.toLowerCase().includes(search.toLowerCase()) ||
          tpl.description.toLowerCase().includes(search.toLowerCase()),
      )
    : templates

  function handleDelete() {
    if (!deleteTarget) return
    const id = deleteTarget
    setDeleteTarget(null)
    void deleteTemplate(id)
  }

  async function handleFork(id: string) {
    const forked = await forkTemplate(id)
    if (!forked) return
    void navigate(`/prompt-templates/${encodeURIComponent(forked.id)}`)
  }

  const deleteTargetTemplate = deleteTarget
    ? templates.find((tpl) => tpl.id === deleteTarget)
    : null

  return (
    <div data-slot="prompt-templates-list-page" className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-6 py-2">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold text-foreground">{t("promptTemplates.title")}</h1>
          {templates.length > 0 && (
            <Badge variant="secondary" className="text-xs">
              {templates.length}
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
        <Button size="sm" asChild>
          <Link to="/prompt-templates/new">
            <PlusIcon className="mr-1.5 size-3.5" />
            {t("promptTemplates.addTemplate")}
          </Link>
        </Button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto flex max-w-2xl flex-col gap-4">
          {/* Search */}
          {!loading && templates.length > 0 && (
            <div className="relative">
              <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder={t("promptTemplates.searchPlaceholder")}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9"
              />
            </div>
          )}

          {/* Loading */}
          {loading && (
            <div className="flex items-center justify-center py-16">
              <LoaderIcon className="size-6 animate-spin text-muted-foreground" />
            </div>
          )}

          {/* Empty state */}
          {!loading && templates.length === 0 && (
            <div className="flex flex-col items-center gap-3 py-16 text-muted-foreground">
              <FileTextIcon className="size-10" />
              <p className="text-sm">{t("promptTemplates.noTemplates")}</p>
              <Button size="sm" variant="outline" asChild>
                <Link to="/prompt-templates/new">
                  <PlusIcon className="mr-1.5 size-3.5" />
                  {t("promptTemplates.createFirstTemplate")}
                </Link>
              </Button>
            </div>
          )}

          {/* No search results */}
          {!loading && templates.length > 0 && filtered.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {t("promptTemplates.noSearchResults")}
            </p>
          )}

          {/* Template cards */}
          {!loading &&
            filtered.map((tpl) => (
              <Link
                key={tpl.id}
                to={`/prompt-templates/${encodeURIComponent(tpl.id)}`}
                className="block"
              >
                <Card size="sm" interactive>
                  <CardHeader>
                    <div className="flex items-center gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <CardTitle>{tpl.name}</CardTitle>
                          <Badge variant="outline" className="text-xs">
                            {tpl.role}
                          </Badge>
                          {tpl.builtin && (
                            <Badge variant="secondary" className="text-xs">
                              {t("promptTemplates.builtin")}
                            </Badge>
                          )}
                        </div>
                        {tpl.description && (
                          <p className="text-sm text-muted-foreground line-clamp-1">
                            {tpl.description}
                          </p>
                        )}
                      </div>
                    </div>
                    <CardAction>
                      {tpl.builtin && (
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label={t("promptTemplates.forkTemplate")}
                          disabled={saveState === "saving"}
                          onClick={(e) => {
                            e.preventDefault()
                            e.stopPropagation()
                            void handleFork(tpl.id)
                          }}
                        >
                          <CopyPlusIcon className="size-3.5" />
                        </Button>
                      )}
                      {!tpl.builtin && (
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label={`Delete template ${tpl.name}`}
                          disabled={saveState === "saving"}
                          onClick={(e) => {
                            e.preventDefault()
                            e.stopPropagation()
                            setDeleteTarget(tpl.id)
                          }}
                        >
                          <Trash2Icon className="size-3.5 text-destructive" />
                        </Button>
                      )}
                    </CardAction>
                  </CardHeader>
                </Card>
              </Link>
            ))}
        </div>
      </div>

      {/* Delete confirmation */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={() => setDeleteTarget(null)}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("promptTemplates.deleteTemplate")}</AlertDialogTitle>
            <AlertDialogDescription>
              <Trans
                i18nKey="promptTemplates.deleteTemplateDescription"
                values={{ name: deleteTargetTemplate?.name ?? "" }}
                components={{ strong: <strong /> }}
              />
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
