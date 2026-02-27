import { useState } from "react"
import { useTranslation, Trans } from "react-i18next"
import { Link } from "react-router"
import {
  PlusIcon,
  BookTextIcon,
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
  CardContent,
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
import { usePlaybooksContext } from "./playbooks-layout"

export function PlaybooksListPage() {
  const { t } = useTranslation()
  const { playbooks, loading, saveState, error, deletePlaybook } = usePlaybooksContext()
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [search, setSearch] = useState("")

  const filtered = search
    ? playbooks.filter((playbook) => {
      const query = search.toLowerCase()
      return playbook.name.toLowerCase().includes(query)
        || playbook.description.toLowerCase().includes(query)
        || playbook.tags.some((tag) => tag.toLowerCase().includes(query))
        || playbook.triggers.some((trigger) => trigger.toLowerCase().includes(query))
    })
    : playbooks

  function handleDelete() {
    if (!deleteTarget) return
    const name = deleteTarget
    setDeleteTarget(null)
    void deletePlaybook(name)
  }

  return (
    <div data-slot="playbooks-list-page" className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-6 py-2">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold text-foreground">{t("playbooks.title")}</h1>
          {playbooks.length > 0 && (
            <Badge variant="secondary" className="text-xs">
              {playbooks.length}
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
          <Link to="/playbooks/__new">
            <PlusIcon className="mr-1.5 size-3.5" />
            {t("playbooks.addPlaybook")}
          </Link>
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
          {!loading && playbooks.length > 0 && (
            <div className="relative">
              <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder={t("playbooks.searchPlaceholder")}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9"
              />
            </div>
          )}

          {loading && (
            <div className="flex items-center justify-center py-16">
              <LoaderIcon className="size-6 animate-spin text-muted-foreground" />
            </div>
          )}

          {!loading && playbooks.length === 0 && (
            <div className="flex flex-col items-center gap-3 py-16 text-muted-foreground">
              <BookTextIcon className="size-10" />
              <p className="text-sm">{t("playbooks.noPlaybooks")}</p>
              <Button size="sm" variant="outline" asChild>
                <Link to="/playbooks/__new">
                  <PlusIcon className="mr-1.5 size-3.5" />
                  {t("playbooks.createFirstPlaybook")}
                </Link>
              </Button>
            </div>
          )}

          {!loading && playbooks.length > 0 && filtered.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {t("playbooks.noSearchResults")}
            </p>
          )}

          {!loading && filtered.map((playbook) => (
            <Link
              key={playbook.name}
              to={`/playbooks/${encodeURIComponent(playbook.name)}`}
              className="block rounded-2xl"
            >
              <Card size="sm" interactive>
                <CardHeader>
                  <div className="flex min-w-0 flex-1 items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <CardTitle>{playbook.name}</CardTitle>
                      {playbook.description && (
                        <p className="text-sm text-muted-foreground line-clamp-1">
                          {playbook.description}
                        </p>
                      )}
                    </div>
                  </div>
                  <CardAction>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`Delete playbook ${playbook.name}`}
                      onClick={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        setDeleteTarget(playbook.name)
                      }}
                    >
                      <Trash2Icon className="size-3.5 text-destructive" />
                    </Button>
                  </CardAction>
                </CardHeader>

                <CardContent className="flex flex-wrap gap-1.5">
                  <Badge variant="outline" className="text-xs">
                    {t("playbooks.scriptCount", { count: playbook.scriptCount })}
                  </Badge>
                  {!playbook.inIndex && (
                    <Badge variant="destructive" className="text-xs">
                      {t("playbooks.statusMissingIndex")}
                    </Badge>
                  )}
                  {!playbook.onDisk && (
                    <Badge variant="destructive" className="text-xs">
                      {t("playbooks.statusMissingDir")}
                    </Badge>
                  )}
                  {playbook.onDisk && !playbook.readmeExists && (
                    <Badge variant="destructive" className="text-xs">
                      {t("playbooks.statusMissingReadme")}
                    </Badge>
                  )}
                  {playbook.tags.slice(0, 3).map((tag) => (
                    <Badge key={tag} variant="secondary" className="text-xs">
                      #{tag}
                    </Badge>
                  ))}
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      </div>

      <AlertDialog open={deleteTarget !== null} onOpenChange={() => setDeleteTarget(null)}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("playbooks.deletePlaybook")}</AlertDialogTitle>
            <AlertDialogDescription>
              <Trans
                i18nKey="playbooks.deletePlaybookDescription"
                values={{ name: deleteTarget ?? "" }}
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
