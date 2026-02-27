import { mkdirSync } from "fs";
import { dirname } from "path";
import Database from "better-sqlite3";
import { Cron } from "croner";
import type { Schedule, ScheduleStatus } from "./types.js";
import { logger } from "../logger.js";

/** Map a DB row to a Schedule object. */
function rowToSchedule(row: Record<string, unknown>): Schedule {
  return {
    id: row.id as string,
    teamId: row.team_id as string,
    prompt: row.prompt as string,
    type: row.type as Schedule["type"],
    cron: row.cron as string | null,
    runAt: row.run_at as string | null,
    timezone: row.timezone as string,
    integrations: row.integrations as string,
    conditional: (row.conditional as number) === 1,
    status: row.status as ScheduleStatus,
    nextRun: row.next_run as string | null,
    lastRun: row.last_run as string | null,
    failCount: row.fail_count as number,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export class ScheduleStore {
  private db: Database.Database;

  private constructor(db: Database.Database) {
    this.db = db;
  }

  /** Async factory — mirrors MemoryStore.create pattern. */
  static async create(dbPath: string): Promise<ScheduleStore> {
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    const store = new ScheduleStore(db);
    store.createSchema();
    return store;
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        type TEXT NOT NULL,
        cron TEXT,
        run_at TEXT,
        timezone TEXT NOT NULL DEFAULT 'UTC',
        integrations TEXT NOT NULL DEFAULT '',
        conditional INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        next_run TEXT,
        last_run TEXT,
        fail_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_schedules_next_run ON schedules(next_run);
      CREATE INDEX IF NOT EXISTS idx_schedules_status ON schedules(status);
      CREATE INDEX IF NOT EXISTS idx_schedules_team ON schedules(team_id);

      CREATE TABLE IF NOT EXISTS scheduler_settings (
        team_id TEXT PRIMARY KEY,
        timezone TEXT NOT NULL DEFAULT 'UTC'
      );
    `);
  }

  // --- CRUD ---

  create(schedule: Schedule): void {
    this.db
      .prepare(
        `INSERT INTO schedules (
          id, team_id, prompt, type, cron, run_at, timezone,
          integrations, conditional,
          status, next_run, last_run, fail_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        schedule.id,
        schedule.teamId,
        schedule.prompt,
        schedule.type,
        schedule.cron,
        schedule.runAt,
        schedule.timezone,
        schedule.integrations,
        schedule.conditional ? 1 : 0,
        schedule.status,
        schedule.nextRun,
        schedule.lastRun,
        schedule.failCount,
        schedule.createdAt,
        schedule.updatedAt,
      );
  }

  getById(id: string): Schedule | null {
    const row = this.db
      .prepare("SELECT * FROM schedules WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? rowToSchedule(row) : null;
  }

  listByTeam(teamId: string, status?: ScheduleStatus): Schedule[] {
    if (status) {
      const rows = this.db
        .prepare("SELECT * FROM schedules WHERE team_id = ? AND status = ? ORDER BY created_at DESC")
        .all(teamId, status) as Record<string, unknown>[];
      return rows.map(rowToSchedule);
    }
    const rows = this.db
      .prepare("SELECT * FROM schedules WHERE team_id = ? ORDER BY created_at DESC")
      .all(teamId) as Record<string, unknown>[];
    return rows.map(rowToSchedule);
  }

  /** Get all schedules that are due (next_run <= now and status = 'active'). */
  getDueSchedules(now: Date): Schedule[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM schedules WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?",
      )
      .all(now.toISOString()) as Record<string, unknown>[];
    return rows.map(rowToSchedule);
  }

  /** Get all schedules with a specific status. */
  getByStatus(status: ScheduleStatus): Schedule[] {
    const rows = this.db
      .prepare("SELECT * FROM schedules WHERE status = ?")
      .all(status) as Record<string, unknown>[];
    return rows.map(rowToSchedule);
  }

  /** Update specific fields on a schedule. */
  update(
    id: string,
    fields: Partial<Pick<Schedule, "status" | "nextRun" | "lastRun" | "failCount">>,
  ): void {
    const sets: string[] = [];
    const values: unknown[] = [];

    if (fields.status !== undefined) {
      sets.push("status = ?");
      values.push(fields.status);
    }
    if (fields.nextRun !== undefined) {
      sets.push("next_run = ?");
      values.push(fields.nextRun);
    }
    if (fields.lastRun !== undefined) {
      sets.push("last_run = ?");
      values.push(fields.lastRun);
    }
    if (fields.failCount !== undefined) {
      sets.push("fail_count = ?");
      values.push(fields.failCount);
    }

    if (sets.length === 0) return;

    sets.push("updated_at = ?");
    values.push(new Date().toISOString());
    values.push(id);

    this.db.prepare(`UPDATE schedules SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  }

  delete(id: string): boolean {
    const info = this.db.prepare("DELETE FROM schedules WHERE id = ?").run(id);
    return info.changes > 0;
  }

  /** Mark a schedule as completed for this run and advance to the next. */
  markCompleted(id: string, nextRun: string | null): void {
    const now = new Date().toISOString();
    if (nextRun) {
      // Recurring — advance to next run
      this.db
        .prepare(
          "UPDATE schedules SET last_run = ?, next_run = ?, fail_count = 0, updated_at = ? WHERE id = ?",
        )
        .run(now, nextRun, now, id);
    } else {
      // One-shot — mark completed
      this.db
        .prepare(
          "UPDATE schedules SET last_run = ?, next_run = NULL, status = 'completed', fail_count = 0, updated_at = ? WHERE id = ?",
        )
        .run(now, now, id);
    }
  }

  /** Increment fail count and optionally advance the schedule. */
  markFailed(id: string, nextRun: string | null): void {
    const now = new Date().toISOString();
    if (nextRun) {
      // Recurring — advance despite failure
      this.db
        .prepare(
          "UPDATE schedules SET last_run = ?, next_run = ?, fail_count = fail_count + 1, updated_at = ? WHERE id = ?",
        )
        .run(now, nextRun, now, id);
    } else {
      // One-shot — mark failed
      this.db
        .prepare(
          "UPDATE schedules SET last_run = ?, next_run = NULL, status = 'failed', fail_count = fail_count + 1, updated_at = ? WHERE id = ?",
        )
        .run(now, now, id);
    }
  }

  // --- Next run computation ---

  /** Compute the next run time for a recurring schedule using croner. */
  computeNextRun(schedule: Schedule): string | null {
    if (schedule.type !== "recurring" || !schedule.cron) return null;
    try {
      const job = new Cron(schedule.cron, { timezone: schedule.timezone });
      const next = job.nextRun();
      return next ? next.toISOString() : null;
    } catch (err) {
      logger.warn(
        `Failed to compute next run for schedule ${schedule.id}: ${err instanceof Error ? err.message : err}`,
      );
      return null;
    }
  }

  // --- Team Settings ---

  setTimezone(teamId: string, timezone: string): void {
    this.db
      .prepare(
        "INSERT INTO scheduler_settings (team_id, timezone) VALUES (?, ?) ON CONFLICT(team_id) DO UPDATE SET timezone = ?",
      )
      .run(teamId, timezone, timezone);
  }

  getTimezone(teamId: string): string | null {
    const row = this.db
      .prepare("SELECT timezone FROM scheduler_settings WHERE team_id = ?")
      .get(teamId) as { timezone: string } | undefined;
    return row?.timezone ?? null;
  }

  close(): void {
    this.db.close();
    logger.info("Schedule store closed");
  }
}
