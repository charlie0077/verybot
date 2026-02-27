import { mkdirSync } from "fs";
import { dirname } from "path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { logger } from "../logger.js";
import type { Task, TaskAttachment, TaskComment, TaskStatus, TaskPriority } from "./types.js";
import { DEFAULT_TEAM_ID } from "../config/agent-config.js";

export interface CreateTaskInput {
  title: string;
  description?: string;
  teamId?: string;
  assignee?: string;
  priority?: TaskPriority;
  status?: TaskStatus;
  needsHumanReview?: boolean;
  attachments?: TaskAttachment[];
}

export interface CreateTaskOptions {
  /** Actor that created the task. */
  updatedBy?: string;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string | null;
  status?: TaskStatus;
  assignee?: string | null;
  priority?: TaskPriority;
  teamId?: string | null;
  needsHumanReview?: boolean;
  attachments?: TaskAttachment[];
}

export interface UpdateTaskOptions {
  /** Whether to clear claim ownership when the task status changes. */
  clearClaimOnStatusChange?: boolean;
  /** Actor that performed the update. */
  updatedBy?: string;
}

export interface ListTasksFilter {
  teamId?: string;
  status?: TaskStatus;
  assignee?: string;
  needsHumanReview?: boolean;
  includeArchived?: boolean;
}

export interface CreateTaskCommentOptions {
  /** Actor that created the comment. */
  actor?: string;
}

export interface UpdateTaskCommentOptions {
  /** Actor that edited the comment. */
  actor?: string;
}

export interface DeleteTaskCommentOptions {
  /** Actor that deleted the comment. */
  actor?: string;
}

const DEFAULT_TASK_ACTOR = "system";
const HUMAN_TASK_ACTOR = "user";
const EMPTY_STATUS_POSITION = 0;

/**
 * SQLite-backed persistence for team tasks.
 * Shares the same DB file as MemoryStore, ScheduleStore, etc.
 */
export class TaskStore {
  private db: Database.Database;

  private constructor(db: Database.Database) {
    this.db = db;
  }

  static async create(dbPath: string): Promise<TaskStore> {
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    const store = new TaskStore(db);
    store.createSchema();
    store.migrate();
    return store;
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        team_id TEXT,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'todo',
        assignee TEXT,
        priority TEXT NOT NULL DEFAULT 'medium',
        position INTEGER NOT NULL DEFAULT 0,
        needs_human_review INTEGER NOT NULL DEFAULT 0,
        last_processed_by TEXT,
        last_processed_for_updated_at INTEGER,
        updated_by TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_team ON tasks(team_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee);

      CREATE TABLE IF NOT EXISTS task_comments (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        content TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_task_comments_task ON task_comments(task_id);
      CREATE INDEX IF NOT EXISTS idx_task_comments_created_at ON task_comments(created_at);

      CREATE TABLE IF NOT EXISTS task_counters (
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      );
    `);
  }

  /** Add position column for existing databases that lack it. */
  private migrate(): void {
    const columns = this.db.pragma("table_info(tasks)") as { name: string }[];
    const hasPosition = columns.some((c) => c.name === "position");
    if (!hasPosition) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN position INTEGER NOT NULL DEFAULT 0");
      // Backfill: assign positions based on created_at DESC per status
      for (const status of ["backlog", "todo", "plan", "in_progress", "done", "archived"]) {
        const rows = this.db
          .prepare("SELECT id FROM tasks WHERE status = ? ORDER BY created_at DESC")
          .all(status) as { id: string }[];
        const stmt = this.db.prepare("UPDATE tasks SET position = ? WHERE id = ?");
        rows.forEach((row, i) => stmt.run(i, row.id));
      }
      logger.info("Migrated tasks table: added position column");
    }

    const hasAttachments = columns.some((c) => c.name === "attachments");
    if (!hasAttachments) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN attachments TEXT DEFAULT '[]'");
      logger.info("Migrated tasks table: added attachments column");
    }

    const hasNeedsHumanReview = columns.some((c) => c.name === "needs_human_review");
    if (!hasNeedsHumanReview) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN needs_human_review INTEGER NOT NULL DEFAULT 0");
      logger.info("Migrated tasks table: added needs_human_review column");
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_human_review ON tasks(needs_human_review)");

    // Backfill NULL team_id → "default"
    const nullCount = this.db
      .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE team_id IS NULL`)
      .get() as { n: number };
    if (nullCount.n > 0) {
      this.db.prepare(`UPDATE tasks SET team_id = ? WHERE team_id IS NULL`).run(DEFAULT_TEAM_ID);
      logger.info(`Migrated ${nullCount.n} tasks: set NULL team_id to '${DEFAULT_TEAM_ID}'`);
    }

    // Add claimed_by / claimed_at columns for pull-based task subscriptions
    const hasClaimedBy = columns.some((c) => c.name === "claimed_by");
    if (!hasClaimedBy) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN claimed_by TEXT");
      this.db.exec("ALTER TABLE tasks ADD COLUMN claimed_at INTEGER");
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_claimed ON tasks(claimed_by)");
      logger.info("Migrated tasks table: added claimed_by, claimed_at columns");
    }

    // Add actor audit field for task updates.
    const hasUpdatedBy = columns.some((c) => c.name === "updated_by");
    if (!hasUpdatedBy) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN updated_by TEXT");
      this.db.prepare("UPDATE tasks SET updated_by = ? WHERE updated_by IS NULL").run("legacy");
      logger.info("Migrated tasks table: added updated_by column");
    }

    // Add processed-marker fields for subscription dedupe.
    const hasLastProcessedBy = columns.some((c) => c.name === "last_processed_by");
    if (!hasLastProcessedBy) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN last_processed_by TEXT");
      logger.info("Migrated tasks table: added last_processed_by column");
    }
    const hasLastProcessedForUpdatedAt = columns.some((c) => c.name === "last_processed_for_updated_at");
    if (!hasLastProcessedForUpdatedAt) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN last_processed_for_updated_at INTEGER");
      logger.info("Migrated tasks table: added last_processed_for_updated_at column");
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_last_processed ON tasks(last_processed_by, last_processed_for_updated_at)");

    this.ensureTaskIdCounter();
  }

  /** Initialize or bump task ID counter based on highest numeric task id in DB. */
  private ensureTaskIdCounter(): void {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(CAST(id AS INTEGER)), 0) AS max_id
         FROM tasks
         WHERE id <> '' AND id NOT GLOB '*[^0-9]*'`,
      )
      .get() as { max_id: number };
    const nextId = Number(row.max_id) + 1;

    const current = this.db
      .prepare("SELECT value FROM task_counters WHERE key = 'task_id'")
      .get() as { value: number } | undefined;

    if (!current) {
      this.db
        .prepare("INSERT INTO task_counters (key, value) VALUES ('task_id', ?)")
        .run(nextId);
      return;
    }

    if (current.value < nextId) {
      this.db
        .prepare("UPDATE task_counters SET value = ? WHERE key = 'task_id'")
        .run(nextId);
    }
  }

  /** Allocate next task ID as an incrementing number persisted in SQLite. */
  private nextTaskId(): string {
    const next = this.db.transaction(() => {
      const current = this.db
        .prepare("SELECT value FROM task_counters WHERE key = 'task_id'")
        .get() as { value: number } | undefined;
      const value = current?.value ?? 1;

      if (!current) {
        this.db
          .prepare("INSERT INTO task_counters (key, value) VALUES ('task_id', ?)")
          .run(value + 1);
      } else {
        this.db
          .prepare("UPDATE task_counters SET value = ? WHERE key = 'task_id'")
          .run(value + 1);
      }
      return value;
    })();

    return String(next);
  }

  /** Get the next position value for a given status (appends to end). */
  private nextPosition(status: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(position), -1) + 1 AS next FROM tasks WHERE status = ?")
      .get(status) as { next: number };
    return row.next;
  }

  /** Get the next position value for a given status (prepends to top). */
  private topPosition(status: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(MIN(position), ?) - 1 AS next FROM tasks WHERE status = ?")
      .get(EMPTY_STATUS_POSITION + 1, status) as { next: number };
    return row.next;
  }

  create(input: CreateTaskInput, options: CreateTaskOptions = {}): Task {
    const now = Date.now();
    const status = input.status ?? "todo";
    const updatedBy = options.updatedBy ?? DEFAULT_TASK_ACTOR;
    const task: Task = {
      id: this.nextTaskId(),
      teamId: input.teamId || DEFAULT_TEAM_ID,
      title: input.title,
      description: input.description ?? null,
      status,
      assignee: input.assignee ?? null,
      priority: input.priority ?? "medium",
      position: this.nextPosition(status),
      needsHumanReview: input.needsHumanReview ?? false,
      attachments: input.attachments ?? [],
      claimedBy: null,
      claimedAt: null,
      updatedBy,
      createdAt: now,
      updatedAt: now,
    };

    this.db
      .prepare(
        `INSERT INTO tasks (id, team_id, title, description, status, assignee, priority, position, needs_human_review, attachments, claimed_by, claimed_at, updated_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        task.teamId,
        task.title,
        task.description,
        task.status,
        task.assignee,
        task.priority,
        task.position,
        task.needsHumanReview ? 1 : 0,
        JSON.stringify(task.attachments),
        null,
        null,
        task.updatedBy,
        task.createdAt,
        task.updatedAt,
      );

    return task;
  }

  update(id: string, input: UpdateTaskInput, options: UpdateTaskOptions = {}): Task | null {
    const existing = this.getById(id);
    if (!existing) return null;

    // When status changes, assign position at top of destination column
    const statusChanged = input.status !== undefined && input.status !== existing.status;
    const newPosition = statusChanged ? this.topPosition(input.status!) : existing.position;

    // Default behavior: clear claim on status changes so a new subscriber can pick it up.
    // Strict subscription flows can opt out and release claim explicitly after run completion.
    const clearClaimOnStatusChange = options.clearClaimOnStatusChange ?? true;
    const clearClaim = statusChanged && clearClaimOnStatusChange;
    const updatedBy = options.updatedBy ?? DEFAULT_TASK_ACTOR;
    const isHumanUpdate = updatedBy === HUMAN_TASK_ACTOR;
    const needsHumanReview = input.needsHumanReview !== undefined
      ? input.needsHumanReview
      : isHumanUpdate
        ? false
        : existing.needsHumanReview;

    const updated: Task = {
      ...existing,
      ...(input.title !== undefined && { title: input.title }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.status !== undefined && { status: input.status }),
      ...(input.assignee !== undefined && { assignee: input.assignee }),
      ...(input.priority !== undefined && { priority: input.priority }),
      ...(input.teamId !== undefined && { teamId: input.teamId || DEFAULT_TEAM_ID }),
      ...(input.attachments !== undefined && { attachments: input.attachments }),
      needsHumanReview,
      ...(clearClaim && { claimedBy: null, claimedAt: null }),
      updatedBy,
      position: newPosition,
      updatedAt: Date.now(),
    };

    this.db
      .prepare(
        `UPDATE tasks SET team_id = ?, title = ?, description = ?, status = ?, assignee = ?, priority = ?, position = ?, needs_human_review = ?, attachments = ?, claimed_by = ?, claimed_at = ?, updated_by = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        updated.teamId,
        updated.title,
        updated.description,
        updated.status,
        updated.assignee,
        updated.priority,
        updated.position,
        updated.needsHumanReview ? 1 : 0,
        JSON.stringify(updated.attachments),
        updated.claimedBy,
        updated.claimedAt,
        updated.updatedBy,
        updated.updatedAt,
        id,
      );

    return updated;
  }

  /**
   * Bulk-reorder tasks within a status column. Sets positions 0, 1, 2, ...
   * Reordering is a board-layout concern and must not mutate task freshness fields
   * (for example updated_at), otherwise subscription workers re-run unchanged tasks.
   */
  reorder(status: TaskStatus, orderedIds: string[]): void {
    const stmt = this.db.prepare("UPDATE tasks SET position = ? WHERE id = ? AND status = ?");
    const tx = this.db.transaction(() => {
      orderedIds.forEach((id, i) => stmt.run(i, id, status));
    });
    tx();
  }

  delete(id: string): boolean {
    const info = this.db.transaction(() => {
      this.db.prepare("DELETE FROM task_comments WHERE task_id = ?").run(id);
      return this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
    })();
    return info.changes > 0;
  }

  getById(id: string): Task | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? toTask(row) : null;
  }

  list(filter: ListTasksFilter = {}): Task[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.teamId) {
      conditions.push("team_id = ?");
      params.push(filter.teamId);
    }

    if (filter.status) {
      conditions.push("status = ?");
      params.push(filter.status);
    } else if (!filter.includeArchived) {
      conditions.push("status != 'archived'");
    }

    if (filter.assignee) {
      conditions.push("assignee = ?");
      params.push(filter.assignee);
    }

    if (filter.needsHumanReview !== undefined) {
      conditions.push("needs_human_review = ?");
      params.push(filter.needsHumanReview ? 1 : 0);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM tasks ${where} ORDER BY position ASC`)
      .all(...params) as Record<string, unknown>[];

    return rows.map(toTask);
  }

  listComments(taskId: string): TaskComment[] {
    const rows = this.db
      .prepare("SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at ASC, id ASC")
      .all(taskId) as Record<string, unknown>[];
    return rows.map(toTaskComment);
  }

  addComment(taskId: string, content: string, options: CreateTaskCommentOptions = {}): TaskComment | null {
    const task = this.getById(taskId);
    if (!task) return null;

    const now = Date.now();
    const actor = options.actor ?? DEFAULT_TASK_ACTOR;
    const normalizedContent = content.trim();
    const comment: TaskComment = {
      id: randomUUID(),
      taskId,
      content: normalizedContent,
      createdBy: actor,
      updatedBy: actor,
      createdAt: now,
      updatedAt: now,
    };

    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO task_comments (id, task_id, content, created_by, updated_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          comment.id,
          comment.taskId,
          comment.content,
          comment.createdBy,
          comment.updatedBy,
          comment.createdAt,
          comment.updatedAt,
        );
      this.touchTaskAudit(taskId, actor, now);
    })();

    return comment;
  }

  updateComment(id: string, content: string, options: UpdateTaskCommentOptions = {}): TaskComment | null {
    const existing = this.getCommentById(id);
    if (!existing) return null;

    const now = Date.now();
    const actor = options.actor ?? DEFAULT_TASK_ACTOR;
    const normalizedContent = content.trim();
    const updated: TaskComment = {
      ...existing,
      content: normalizedContent,
      updatedBy: actor,
      updatedAt: now,
    };

    this.db.transaction(() => {
      this.db
        .prepare("UPDATE task_comments SET content = ?, updated_by = ?, updated_at = ? WHERE id = ?")
        .run(updated.content, updated.updatedBy, updated.updatedAt, id);
      this.touchTaskAudit(existing.taskId, actor, now);
    })();

    return updated;
  }

  deleteComment(id: string, options: DeleteTaskCommentOptions = {}): TaskComment | null {
    const existing = this.getCommentById(id);
    if (!existing) return null;

    const now = Date.now();
    const actor = options.actor ?? DEFAULT_TASK_ACTOR;
    const info = this.db.transaction(() => {
      const deleteInfo = this.db.prepare("DELETE FROM task_comments WHERE id = ?").run(id);
      if (deleteInfo.changes > 0) {
        this.touchTaskAudit(existing.taskId, actor, now);
      }
      return deleteInfo;
    })();
    return info.changes > 0 ? existing : null;
  }

  /** Bulk-archive all tasks currently in the provided completion status, optionally scoped to a team. */
  archiveDone(teamId?: string, doneStatus = "done", updatedBy = DEFAULT_TASK_ACTOR): number {
    const STATUS_KEY_RE = /^\w+$/;
    if (!STATUS_KEY_RE.test(doneStatus)) {
      throw new Error(`Invalid status key: ${doneStatus}`);
    }
    const now = Date.now();
    if (teamId) {
      const info = this.db
        .prepare("UPDATE tasks SET status = 'archived', updated_by = ?, updated_at = ? WHERE status = ? AND team_id = ?")
        .run(updatedBy, now, doneStatus, teamId);
      return info.changes;
    }
    const info = this.db
      .prepare("UPDATE tasks SET status = 'archived', updated_by = ?, updated_at = ? WHERE status = ?")
      .run(updatedBy, now, doneStatus);
    return info.changes;
  }

  /**
   * Atomically claim the oldest unclaimed task matching the given status for an agent.
   * Respects assignee: assigned tasks only go to that agent, unassigned to any subscriber.
   */
  claimTask(agentId: string, status: string): Task | null {
    return this.db.transaction(() => {
      const row = this.db.prepare(
        `SELECT * FROM tasks
         WHERE status = ? AND claimed_by IS NULL AND needs_human_review = 0
           AND (assignee IS NULL OR assignee = ?)
           AND (
             last_processed_by IS NULL
             OR last_processed_for_updated_at IS NULL
             OR last_processed_by != ?
             OR last_processed_for_updated_at != updated_at
           )
         ORDER BY
           CASE WHEN assignee = ? THEN 0 ELSE 1 END,
           created_at ASC
         LIMIT 1`,
      ).get(status, agentId, agentId, agentId) as Record<string, unknown> | undefined;

      if (!row) return null;

      const now = Date.now();
      this.db.prepare(
        "UPDATE tasks SET claimed_by = ?, claimed_at = ? WHERE id = ?",
      ).run(agentId, now, row.id as string);

      const task = toTask(row);
      task.claimedBy = agentId;
      task.claimedAt = now;
      return task;
    })();
  }

  /** Atomically claim a specific task by ID for an agent. Returns the task if claimed, null if already taken. */
  claimTaskById(taskId: string, agentId: string): Task | null {
    const now = Date.now();
    const info = this.db.prepare(
      "UPDATE tasks SET claimed_by = ?, claimed_at = ? WHERE id = ? AND claimed_by IS NULL AND needs_human_review = 0",
    ).run(agentId, now, taskId);
    if (info.changes === 0) return null;
    return this.getById(taskId);
  }

  /** Release a claimed task so it can be retried. */
  releaseTask(taskId: string): void {
    this.db.prepare(
      "UPDATE tasks SET claimed_by = NULL, claimed_at = NULL WHERE id = ?",
    ).run(taskId);
  }

  /**
   * Release claim only when held by the provided agent id.
   * Returns true when a claim was released.
   */
  releaseTaskIfClaimedBy(taskId: string, agentId: string): boolean {
    const info = this.db.prepare(
      "UPDATE tasks SET claimed_by = NULL, claimed_at = NULL WHERE id = ? AND claimed_by = ?",
    ).run(taskId, agentId);
    return info.changes > 0;
  }

  /**
   * Mark a claimed task as processed by the given agent for the current task version,
   * then release the claim atomically.
   * Returns true when the task was finalized by the expected claim owner.
   */
  finalizeClaimedTaskRun(taskId: string, agentId: string): boolean {
    const info = this.db.prepare(
      `UPDATE tasks
       SET last_processed_by = ?,
           last_processed_for_updated_at = updated_at,
           claimed_by = NULL,
           claimed_at = NULL
       WHERE id = ? AND claimed_by = ?`,
    ).run(agentId, taskId, agentId);
    return info.changes > 0;
  }

  /** Release claims older than the given cutoff timestamp. Returns count of released claims. */
  cleanupStaleClaims(cutoffTimestamp: number): number {
    const info = this.db.prepare(
      "UPDATE tasks SET claimed_by = NULL, claimed_at = NULL WHERE claimed_by IS NOT NULL AND claimed_at < ?",
    ).run(cutoffTimestamp);
    return info.changes;
  }

  close(): void {
    this.db.close();
    logger.info("Task store closed");
  }

  getCommentById(id: string): TaskComment | null {
    const row = this.db.prepare("SELECT * FROM task_comments WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? toTaskComment(row) : null;
  }

  private touchTaskAudit(taskId: string, updatedBy: string, updatedAt: number): void {
    if (updatedBy === HUMAN_TASK_ACTOR) {
      this.db
        .prepare("UPDATE tasks SET updated_by = ?, updated_at = ?, needs_human_review = 0 WHERE id = ?")
        .run(updatedBy, updatedAt, taskId);
      return;
    }
    this.db
      .prepare("UPDATE tasks SET updated_by = ?, updated_at = ? WHERE id = ?")
      .run(updatedBy, updatedAt, taskId);
  }
}

function parseAttachments(raw: unknown): TaskAttachment[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    return JSON.parse(raw) as TaskAttachment[];
  } catch {
    return [];
  }
}

function toTask(row: Record<string, unknown>): Task {
  return {
    id: row.id as string,
    teamId: (row.team_id as string) || DEFAULT_TEAM_ID,
    title: row.title as string,
    description: (row.description as string) ?? null,
    status: row.status as TaskStatus,
    assignee: (row.assignee as string) ?? null,
    priority: row.priority as TaskPriority,
    position: (row.position as number) ?? 0,
    attachments: parseAttachments(row.attachments),
    needsHumanReview: Number(row.needs_human_review ?? 0) === 1,
    claimedBy: (row.claimed_by as string) ?? null,
    claimedAt: (row.claimed_at as number) ?? null,
    updatedBy: (row.updated_by as string) ?? null,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

function toTaskComment(row: Record<string, unknown>): TaskComment {
  return {
    id: row.id as string,
    taskId: row.task_id as string,
    content: row.content as string,
    createdBy: row.created_by as string,
    updatedBy: row.updated_by as string,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}
