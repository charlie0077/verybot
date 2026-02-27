export type ScheduleType = "one_shot" | "recurring"
export type ScheduleStatus = "active" | "paused" | "completed" | "failed"

export interface Schedule {
  id: string
  teamId: string
  prompt: string
  type: ScheduleType
  cron: string | null
  runAt: string | null
  timezone: string
  integrations: string
  conditional: boolean
  status: ScheduleStatus
  nextRun: string | null
  lastRun: string | null
  failCount: number
  createdAt: string
  updatedAt: string
}

export interface SchedulerMessage {
  id: string
  role: "user" | "assistant" | "system"
  content: string
  senderInfo?: string
}

export interface TeamConfig {
  id: string
  name?: string
}
