import { useEffect, useState, useCallback } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"

export interface TeamInfo {
  id: string
  name: string
  color: string
  orchestratorId: string
  orchestratorIdentity: string
  orchestratorModel: string
  workerCount: number
}

interface TeamPickerProps {
  teams: TeamInfo[]
  onSelect: (team: TeamInfo) => void
  onCancel: () => void
}

const IDENTITY_PREVIEW_LEN = 80

function previewIdentity(identity: string): string {
  const trimmed = identity.trim()
  return trimmed.length <= IDENTITY_PREVIEW_LEN
    ? trimmed
    : trimmed.slice(0, IDENTITY_PREVIEW_LEN - 1) + "\u2026"
}

export function TeamPicker({
  teams,
  onSelect,
  onCancel,
}: TeamPickerProps) {
  const { t } = useTranslation()
  const [focusIdx, setFocusIdx] = useState(0)

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onCancel()
      } else if (e.key === "ArrowDown") {
        e.preventDefault()
        setFocusIdx((i) => (i + 1) % teams.length)
      } else if (e.key === "ArrowUp") {
        e.preventDefault()
        setFocusIdx((i) => (i - 1 + teams.length) % teams.length)
      } else if (e.key === "Enter") {
        e.preventDefault()
        onSelect(teams[focusIdx])
      }
    },
    [onCancel, onSelect, teams, focusIdx],
  )

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown)
    return () => document.removeEventListener("keydown", handleKeyDown)
  }, [handleKeyDown])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
      aria-label={t("teams.chooseTeam")}
    >
      <div
        className="w-full max-w-sm rounded-2xl bg-background ring-1 ring-foreground/5 p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-3 text-sm font-medium text-foreground">
          {t("teams.chooseTeam")}
        </h3>
        <div className="flex flex-col gap-2">
          {teams.map((team, i) => (
            <Card
              key={team.id}
              asChild
              size="sm"
              interactive
              className="gap-1 rounded-xl px-3 py-2.5"
            >
              <button
                type="button"
                onClick={() => onSelect(team)}
                onMouseEnter={() => setFocusIdx(i)}
                className="flex flex-col items-start gap-1 text-left"
              >
                <div className="flex items-center gap-2">
                  {team.color && (
                    <span
                      className="size-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: team.color }}
                    />
                  )}
                  <span className="text-sm font-medium text-foreground">
                    {team.name}
                  </span>
                  <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                    {team.orchestratorModel}
                  </Badge>
                  {team.workerCount > 0 && (
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                      {t("teams.workersCount", { count: team.workerCount })}
                    </Badge>
                  )}
                </div>
                <span className="text-xs text-muted-foreground">
                  {previewIdentity(team.orchestratorIdentity)}
                </span>
              </button>
            </Card>
          ))}
        </div>
        <div className="mt-3 flex justify-end">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
        </div>
      </div>
    </div>
  )
}
