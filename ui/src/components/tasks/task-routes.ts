import type { Task } from "./types"

const TASKS_BASE_PATH = "/tasks"
const ARCHIVED_TASKS_PATH = "/tasks/archived"
const TEAM_ID_QUERY_PARAM = "teamId"
const ARCHIVED_QUERY_PARAM = "archived"
const ENABLED_QUERY_VALUE = "1"

export interface TaskRouteOptions {
  includeArchived?: boolean
}

function normalizeSegment(value: string | null | undefined): string {
  return value?.trim() ?? ""
}

function shouldIncludeArchivedValue(value: string | null | undefined): boolean {
  const normalized = normalizeSegment(value).toLowerCase()
  return normalized === ENABLED_QUERY_VALUE || normalized === "true"
}

function appendArchivedQuery(path: string, includeArchived?: boolean): string {
  if (!includeArchived) return path
  return `${path}?${ARCHIVED_QUERY_PARAM}=${ENABLED_QUERY_VALUE}`
}

export function shouldIncludeArchivedFromSearch(search: string): boolean {
  const query = search.startsWith("?") ? search.slice(1) : search
  return shouldIncludeArchivedValue(new URLSearchParams(query).get(ARCHIVED_QUERY_PARAM))
}

export function buildTaskDetailPath(taskId: string, teamId: string, options: TaskRouteOptions = {}): string {
  const normalizedTaskId = normalizeSegment(taskId)
  const normalizedTeamId = normalizeSegment(teamId)
  if (!normalizedTaskId || !normalizedTeamId) return TASKS_BASE_PATH

  const basePath = `${TASKS_BASE_PATH}/${encodeURIComponent(normalizedTeamId)}/${encodeURIComponent(normalizedTaskId)}`
  return appendArchivedQuery(basePath, options.includeArchived)
}

export function buildTaskDetailPathFromTask(task: Pick<Task, "id" | "teamId">, options: TaskRouteOptions = {}): string {
  return buildTaskDetailPath(task.id, task.teamId, options)
}

export function buildTasksListPath(teamId: string | null | undefined): string {
  const params = new URLSearchParams()
  const normalizedTeamId = normalizeSegment(teamId)
  if (normalizedTeamId) {
    params.set(TEAM_ID_QUERY_PARAM, normalizedTeamId)
  }
  const query = params.toString()
  if (!query) return TASKS_BASE_PATH
  return `${TASKS_BASE_PATH}?${query}`
}

export function buildArchivedTasksPath(teamId: string | null | undefined): string {
  const normalizedTeamId = normalizeSegment(teamId)
  if (!normalizedTeamId) return ARCHIVED_TASKS_PATH
  return `${ARCHIVED_TASKS_PATH}?${TEAM_ID_QUERY_PARAM}=${encodeURIComponent(normalizedTeamId)}`
}

export function resolveTaskFromRoute<T extends Pick<Task, "id" | "teamId">>(
  tasks: T[],
  params: { taskId: string | null | undefined; teamId?: string | null | undefined },
): T | null {
  const taskId = normalizeSegment(params.taskId)
  if (!taskId) return null

  const teamId = normalizeSegment(params.teamId)
  if (!teamId) return null
  return tasks.find((task) => task.id === taskId && task.teamId === teamId) ?? null
}
