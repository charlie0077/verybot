import type { Task } from "./types"

function normalizeTaskLabelSegment(value: string, fallback: string): string {
  const normalizedValue = value
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, "")
  return normalizedValue || fallback
}

export function formatTaskLabel(task: Pick<Task, "id" | "teamId">, teamName?: string): string {
  const teamSegment = normalizeTaskLabelSegment(teamName || "", "")
  const teamIdSegment = normalizeTaskLabelSegment(task.teamId || "default", "DEFAULT")
  const keySource = teamSegment || teamIdSegment
  const teamKey = keySource.toUpperCase().slice(0, 3)
  return `${teamKey}-${task.id.toUpperCase()}`
}
