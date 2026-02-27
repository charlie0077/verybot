import { describe, expect, it } from "vitest"
import {
  buildArchivedTasksPath,
  buildTaskDetailPath,
  buildTaskDetailPathFromTask,
  buildTasksListPath,
  resolveTaskFromRoute,
  shouldIncludeArchivedFromSearch,
} from "./task-routes"

describe("buildTaskDetailPath", () => {
  it("builds a team-scoped detail URL", () => {
    expect(buildTaskDetailPath("21", "frontend")).toBe("/tasks/frontend/21")
  })

  it("encodes route segments", () => {
    expect(buildTaskDetailPath("task 1", "team A")).toBe("/tasks/team%20A/task%201")
  })

  it("returns base tasks path when scope is missing", () => {
    expect(buildTaskDetailPath("21", "")).toBe("/tasks")
  })

  it("includes archived query when requested", () => {
    expect(buildTaskDetailPath("21", "frontend", { includeArchived: true })).toBe("/tasks/frontend/21?archived=1")
  })
})

describe("buildTaskDetailPathFromTask", () => {
  it("uses task id and team id", () => {
    expect(buildTaskDetailPathFromTask({ id: "99", teamId: "ops" })).toBe("/tasks/ops/99")
  })

  it("passes includeArchived options through", () => {
    expect(buildTaskDetailPathFromTask({ id: "99", teamId: "ops" }, { includeArchived: true })).toBe("/tasks/ops/99?archived=1")
  })
})

describe("buildTasksListPath", () => {
  it("includes team filter query when team is present", () => {
    expect(buildTasksListPath("qa")).toBe("/tasks?teamId=qa")
  })

  it("returns base tasks path without team", () => {
    expect(buildTasksListPath(null)).toBe("/tasks")
  })
})

describe("buildArchivedTasksPath", () => {
  it("returns archived tasks path without team filter", () => {
    expect(buildArchivedTasksPath(null)).toBe("/tasks/archived")
  })

  it("includes team filter query when team is present", () => {
    expect(buildArchivedTasksPath("qa")).toBe("/tasks/archived?teamId=qa")
  })
})

describe("shouldIncludeArchivedFromSearch", () => {
  it("returns true for archived=1", () => {
    expect(shouldIncludeArchivedFromSearch("?teamId=qa&archived=1")).toBe(true)
  })

  it("returns true for archived=true", () => {
    expect(shouldIncludeArchivedFromSearch("?archived=true")).toBe(true)
  })

  it("returns false when archived query is missing", () => {
    expect(shouldIncludeArchivedFromSearch("?teamId=qa")).toBe(false)
  })

  it("returns false for archived=0", () => {
    expect(shouldIncludeArchivedFromSearch("?archived=0")).toBe(false)
  })
})

describe("resolveTaskFromRoute", () => {
  const tasks = [
    { id: "21", teamId: "frontend", title: "FE Task" },
    { id: "21", teamId: "backend", title: "BE Task" },
    { id: "22", teamId: "frontend", title: "Another Task" },
  ]

  it("matches by task and team id when both are provided", () => {
    const resolved = resolveTaskFromRoute(tasks, { taskId: "21", teamId: "backend" })
    expect(resolved?.title).toBe("BE Task")
  })

  it("returns null when team id is missing", () => {
    expect(resolveTaskFromRoute(tasks, { taskId: "22" })).toBeNull()
  })

  it("returns null when task id is missing", () => {
    expect(resolveTaskFromRoute(tasks, { taskId: "" })).toBeNull()
  })
})
