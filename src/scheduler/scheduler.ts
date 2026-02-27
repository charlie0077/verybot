import type { ScheduleStore } from "./store.js";
import type { Schedule } from "./types.js";
import type { Agent } from "../brain/agent.js";
import type { ConnectedChannelRegistry } from "./connected-channels.js";
import { logger } from "../logger.js";

const TICK_INTERVAL_MS = 5_000;
const MAX_RETRY_COUNT = 1;
/** Prefix that LLM uses to signal "not worth notifying". */
const SKIP_SIGNAL = "[SKIP]";

export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private store: ScheduleStore,
    private agent: Agent,
    private connectedChannels: ConnectedChannelRegistry,
    private tickMs = TICK_INTERVAL_MS,
  ) {}

  start(): void {
    // Catch up missed tasks on startup
    this.catchUp().catch((err) => {
      logger.error(`Scheduler catch-up failed: ${err instanceof Error ? err.message : err}`);
    });

    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        logger.error(`Scheduler tick failed: ${err instanceof Error ? err.message : err}`);
      });
    }, this.tickMs);

    logger.info(`Scheduler started (tick every ${this.tickMs}ms)`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    logger.info("Scheduler stopped");
  }

  /**
   * On startup: fire missed one-shots, skip missed recurring.
   */
  private async catchUp(): Promise<void> {
    const now = new Date();
    const due = this.store.getDueSchedules(now);
    if (due.length === 0) return;

    const oneShots = due.filter((s) => s.type === "one_shot");
    const recurring = due.filter((s) => s.type === "recurring");

    // Skip missed recurring — advance to next future run
    for (const schedule of recurring) {
      const nextRun = this.store.computeNextRun(schedule);
      this.store.markCompleted(schedule.id, nextRun);
      logger.info(
        `[scheduler] Skipped missed recurring "${schedule.prompt.slice(0, 40)}..." → next: ${nextRun}`,
      );
    }

    // Fire missed one-shots
    if (oneShots.length > 0) {
      logger.info(`[scheduler] Catching up ${oneShots.length} missed one-shot task(s)`);
      await Promise.allSettled(oneShots.map((s) => this.executeTask(s)));
    }
  }

  private async tick(): Promise<void> {
    if (this.running) return; // prevent overlapping ticks
    this.running = true;
    try {
      const due = this.store.getDueSchedules(new Date());
      if (due.length === 0) return;

      logger.info(`[scheduler] ${due.length} task(s) due`);
      await Promise.allSettled(due.map((s) => this.executeTask(s)));
    } finally {
      this.running = false;
    }
  }

  private async executeTask(schedule: Schedule): Promise<void> {
    const taskLabel = `"${schedule.prompt.slice(0, 50)}..." (${schedule.id})`;
    logger.info(`[scheduler] Executing task ${taskLabel}`);

    try {
      const reply = await this.agent.runScheduledTask({
        prompt: schedule.prompt,
        teamId: schedule.teamId,
        integrations: schedule.integrations.split(",").filter(Boolean),
      });

      // Check for [SKIP] signal on conditional tasks
      if (schedule.conditional && reply.trimStart().startsWith(SKIP_SIGNAL)) {
        logger.info(`[scheduler] Task ${taskLabel} skipped by LLM`);
        this.advanceSchedule(schedule);
        return;
      }

      // Broadcast to all connected channels for this team
      await this.connectedChannels.broadcastToTeam(schedule.teamId, reply);
      logger.info(`[scheduler] Task ${taskLabel} broadcast to team ${schedule.teamId}`);

      // Reset fail count and advance
      this.advanceSchedule(schedule);
    } catch (err) {
      await this.handleError(schedule, err);
    }
  }

  private advanceSchedule(schedule: Schedule): void {
    const nextRun =
      schedule.type === "recurring" ? this.store.computeNextRun(schedule) : null;
    this.store.markCompleted(schedule.id, nextRun);

    if (nextRun) {
      logger.info(`[scheduler] Next run for ${schedule.id}: ${nextRun}`);
    }
  }

  private async handleError(schedule: Schedule, err: unknown): Promise<void> {
    const msg = err instanceof Error ? err.message : String(err);
    const taskLabel = `"${schedule.prompt.slice(0, 50)}..." (${schedule.id})`;

    // Re-read to get current fail count
    const current = this.store.getById(schedule.id);
    const failCount = (current?.failCount ?? schedule.failCount) + 1;

    if (failCount <= MAX_RETRY_COUNT) {
      // Retry: increment fail count, leave next_run unchanged (fires on next tick)
      logger.warn(`[scheduler] Task ${taskLabel} failed (attempt ${failCount}), will retry: ${msg}`);
      this.store.update(schedule.id, { failCount });
      return;
    }

    // Max retries exceeded — advance the schedule and notify user
    logger.error(`[scheduler] Task ${taskLabel} failed after ${failCount} attempts: ${msg}`);
    const nextRun =
      schedule.type === "recurring" ? this.store.computeNextRun(schedule) : null;
    this.store.markFailed(schedule.id, nextRun);

    // Best-effort notification to connected channels
    try {
      const notification = `Scheduled task failed: "${schedule.prompt.slice(0, 80)}..."\nError: ${msg}`;
      await this.connectedChannels.broadcastToTeam(schedule.teamId, notification);
    } catch {
      logger.warn(`[scheduler] Could not notify about failed task ${schedule.id}`);
    }
  }
}
