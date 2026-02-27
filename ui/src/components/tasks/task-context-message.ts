import type { Task } from "./types"

/** Build a context message for the orchestrator from a task. */
export function buildTaskContextMessage(task: Task): string {
  const lines: string[] = [
    `Use the orchestrator to work on the following task:`,
    "",
    `Task: ${task.title}`,
  ]

  if (task.description) {
    lines.push("", `Description: ${task.description}`)
  }

  lines.push(
    "",
    `Priority: ${task.priority}`,
    `Status: ${task.status}`,
    `Needs human review: ${task.needsHumanReview ? "yes" : "no"}`,
  )

  if (task.assignee) {
    lines.push(`Assignee: ${task.assignee}`)
  }

  return lines.join("\n")
}
