import type { Task, TeamConfig } from "./types"

const TASK_SESSION_MIN_PARTS = 5
const TASK_SESSION_CHANNEL_INDEX = 1
const TASK_SESSION_TASK_ID_INDEX = 2
const TASK_SESSION_TIMESTAMP_PATTERN = /^\d+$/

export interface SessionListEntry {
  key: string
  updatedAt: number
}

export function getTaskMapKey(task: Pick<Task, "teamId" | "id">): string {
  return `${task.teamId}:${task.id}`
}

export function buildTaskSessionMap(sessions: SessionListEntry[]): Record<string, string> {
  const latestByTask: Record<string, string> = {}
  const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)

  for (const session of sorted) {
    const parts = session.key.split(":")
    if (parts.length < TASK_SESSION_MIN_PARTS) continue
    if (parts[TASK_SESSION_CHANNEL_INDEX] !== "task") continue
    if (!TASK_SESSION_TIMESTAMP_PATTERN.test(parts[parts.length - 1] ?? "")) continue

    const teamId = parts[0]
    const taskId = parts[TASK_SESSION_TASK_ID_INDEX]
    if (!teamId || !taskId) continue

    const taskKey = `${teamId}:${taskId}`
    if (!latestByTask[taskKey]) {
      latestByTask[taskKey] = session.key
    }
  }

  return latestByTask
}

export function getSubscribedWorkerIds(task: Task, teams: TeamConfig[]): string[] {
  const team = teams.find((entry) => entry.id === task.teamId)
  if (!team?.workers?.length) return []

  const workers = team.workers.filter((worker) => {
    const subscribed = worker.subscriptions?.includes(task.status) ?? false
    if (!subscribed) return false
    if (task.assignee && worker.id !== task.assignee) return false
    return true
  })

  return workers.map((worker) => worker.id)
}
