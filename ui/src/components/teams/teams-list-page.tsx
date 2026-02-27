import { useState } from "react"
import { useTranslation, Trans } from "react-i18next"
import { Link } from "react-router"
import {
  PlusIcon,
  UsersIcon,
  CrownIcon,
  BotIcon,
  Trash2Icon,
  CheckIcon,
  LoaderIcon,
  AlertCircleIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
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
import { useTeamsContext } from "./teams-layout"

/* ------------------------------------------------------------------ */
/*  Teams list page — /teams                                           */
/* ------------------------------------------------------------------ */

export function TeamsListPage() {
  const { t } = useTranslation()
  const { teams, loading, saveState, error, deleteTeam } = useTeamsContext()
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)

  function handleDelete() {
    if (!deleteTarget) return
    const id = deleteTarget
    setDeleteTarget(null)
    void deleteTeam(id)
  }

  return (
    <div data-slot="teams-list-page" className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-6 py-2">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold text-foreground">{t("teams.title")}</h1>
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
          <Link to="/teams/new">
            <PlusIcon className="mr-1.5 size-3.5" />
            {t("teams.addTeam")}
          </Link>
        </Button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto flex max-w-2xl flex-col gap-4">
          {/* Loading */}
          {loading && (
            <div className="flex items-center justify-center py-16">
              <LoaderIcon className="size-6 animate-spin text-muted-foreground" />
            </div>
          )}

          {/* Empty state */}
          {!loading && teams.length === 0 && (
            <div className="flex flex-col items-center gap-3 py-16 text-muted-foreground">
              <UsersIcon className="size-10" />
              <p className="text-sm">{t("teams.noTeams")}</p>
              <Button size="sm" variant="outline" asChild>
                <Link to="/teams/new">
                  <PlusIcon className="mr-1.5 size-3.5" />
                  {t("teams.createFirstTeam")}
                </Link>
              </Button>
            </div>
          )}

          {/* Team cards */}
          {!loading && teams.map((team) => (
            <Link
              key={team.id}
              to={`/teams/${team.id}`}
              className="block rounded-2xl"
            >
              <Card size="sm" interactive>
                <CardHeader>
                  <div className="flex items-center gap-2">
                    {team.color ? (
                      <span
                        className="size-3 shrink-0 rounded-full"
                        style={{ backgroundColor: team.color }}
                      />
                    ) : (
                      <UsersIcon className="size-4 text-chart-4" />
                    )}
                    <CardTitle>{team.name}</CardTitle>
                  </div>
                  <CardAction>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`Delete team ${team.id}`}
                      onClick={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        setDeleteTarget(team.id)
                      }}
                    >
                      <Trash2Icon className="size-3.5 text-destructive" />
                    </Button>
                  </CardAction>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  {/* Orchestrator preview */}
                  <div className="flex items-center gap-2">
                    <CrownIcon className="size-3.5 text-chart-4" />
                    <span className="text-sm font-medium text-foreground">{team.orchestrator.name || "Orchestrator"}</span>
                    <Badge variant="secondary" className="text-xs">{team.orchestrator.model}</Badge>
                  </div>
                  {team.orchestrator.identity && (
                    <p className="ml-5 text-sm text-muted-foreground line-clamp-1">
                      {team.orchestrator.identity}
                    </p>
                  )}

                  {/* Workers count */}
                  <div className="flex items-center gap-2">
                    <BotIcon className="size-3.5 text-chart-3" />
                    <span className="text-xs text-muted-foreground">
                      {team.workers.length === 0
                        ? t("teams.noWorkersMessage")
                        : t("teams.workersCount", { count: team.workers.length })}
                    </span>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      </div>

      {/* Delete confirmation */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={() => setDeleteTarget(null)}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("teams.deleteTeam")}</AlertDialogTitle>
            <AlertDialogDescription>
              <Trans
                i18nKey="teams.deleteTeamDescription"
                values={{ name: teams.find((tm) => tm.id === deleteTarget)?.name ?? deleteTarget }}
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
