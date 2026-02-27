export type ScheduleType = "one_shot" | "recurring";
export type ScheduleStatus = "active" | "paused" | "completed" | "failed";

export interface Schedule {
  id: string;
  /** Team that owns this schedule */
  teamId: string;
  /** The user's instruction / prompt for the LLM */
  prompt: string;
  type: ScheduleType;
  /** Cron expression (recurring only) */
  cron: string | null;
  /** ISO timestamp (one-shot only) */
  runAt: string | null;
  /** IANA timezone, e.g. "America/New_York" */
  timezone: string;
  /** Comma-separated integration names to enable for this task */
  integrations: string;
  /** Whether the LLM can skip delivery with [SKIP] */
  conditional: boolean;
  status: ScheduleStatus;
  /** ISO timestamp of next scheduled run */
  nextRun: string | null;
  /** ISO timestamp of last completed run */
  lastRun: string | null;
  /** Number of consecutive failures */
  failCount: number;
  createdAt: string;
  updatedAt: string;
}
