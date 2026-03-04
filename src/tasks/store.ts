import { mkdirSync } from "fs";
import { dirname } from "path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { logger } from "../logger.js";
import { emit } from "../events.js";
import type { Task, TaskAttachment, TaskComment, TaskClaim, TaskStatus, TaskPriority } from "./types.js";
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
  /** Skip claim cleanup (used when vote was just recorded and shouldn't be cleared). */
  skipClaimCleanup?: boolean;
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

      CREATE TABLE IF NOT EXISTS task_claims (
        task_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        task_status TEXT NOT NULL,
        claimed_at INTEGER NOT NULL,
        completed_at INTEGER,
        voted_status TEXT,
        result TEXT,
        PRIMARY KEY (task_id, agent_id, task_status)
      );
      CREATE INDEX IF NOT EXISTS idx_task_claims_task_status ON task_claims(task_id, task_status);
      CREATE INDEX IF NOT EXISTS idx_task_claims_agent_completed ON task_claims(agent_id, completed_at);
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

    // task_claims table + indexes are created in createSchema()

    // One-time migration: backfill task_claims from legacy claimed_by data
    const migrated = this.db.prepare("SELECT value FROM task_counters WHERE key = 'claims_migrated'").get() as { value: number } | undefined;
    if (!migrated) {
      this.db.transaction(() => {
        // Migrate existing claimed_by data to task_claims rows (active claims)
        const claimedRows = this.db
          .prepare("SELECT id, status, claimed_by, claimed_at FROM tasks WHERE claimed_by IS NOT NULL")
          .all() as { id: string; status: string; claimed_by: string; claimed_at: number }[];
        if (claimedRows.length > 0) {
          const insertClaim = this.db.prepare(
            "INSERT OR IGNORE INTO task_claims (task_id, agent_id, task_status, claimed_at) VALUES (?, ?, ?, ?)",
          );
          for (const row of claimedRows) {
            insertClaim.run(row.id, row.claimed_by, row.status, row.claimed_at);
          }
          logger.info(`Migrated ${claimedRows.length} existing claims to task_claims table`);
        }

        // Backfill finalized claim state: tasks with last_processed_by whose processing
        // is current (version matches) but no matching claim row. Only backfill when
        // processing is still valid; stale-processed tasks should be re-claimable.
        const finalizedRows = this.db
          .prepare(
            `SELECT id, status, last_processed_by, updated_at FROM tasks
             WHERE last_processed_by IS NOT NULL
               AND last_processed_for_updated_at = updated_at
               AND NOT EXISTS (
                 SELECT 1 FROM task_claims
                 WHERE task_claims.task_id = tasks.id
                   AND task_claims.agent_id = tasks.last_processed_by
                   AND task_claims.task_status = tasks.status
               )`,
          )
          .all() as { id: string; status: string; last_processed_by: string; updated_at: number }[];
        if (finalizedRows.length > 0) {
          const insertFinalized = this.db.prepare(
            "INSERT OR IGNORE INTO task_claims (task_id, agent_id, task_status, claimed_at, completed_at) VALUES (?, ?, ?, ?, ?)",
          );
          for (const row of finalizedRows) {
            insertFinalized.run(row.id, row.last_processed_by, row.status, row.updated_at, row.updated_at);
          }
          logger.info(`Backfilled ${finalizedRows.length} finalized claims to task_claims table`);
        }

        this.db.prepare("INSERT INTO task_counters (key, value) VALUES ('claims_migrated', 1)").run();
      })();
    }

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

    // Clear completed claims so agents can re-process updated tasks.
    // Skip when caller explicitly opts out (e.g., vote + field update in same call).
    if (!options.skipClaimCleanup) {
      if (statusChanged) {
        if (clearClaimOnStatusChange) {
          this.clearAllClaimsForTask(id);
        }
      } else {
        const contentChanged = input.title !== undefined || input.description !== undefined || input.attachments !== undefined;
        if (contentChanged) {
          // Content edits invalidate existing votes — clear COMPLETED claims (including voted)
          // so consensus restarts based on the updated content.
          // Preserve active (uncompleted) claims so workers don't lose their in-progress claims.
          this.db.prepare(
            "DELETE FROM task_claims WHERE task_id = ? AND task_status = ? AND completed_at IS NOT NULL",
          ).run(id, existing.status);
        } else {
          this.db.prepare(
            "DELETE FROM task_claims WHERE task_id = ? AND task_status = ? AND completed_at IS NOT NULL AND voted_status IS NULL",
          ).run(id, existing.status);
        }
      }
    }

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
      this.db.prepare("DELETE FROM task_claims WHERE task_id = ?").run(id);
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
   * NOTE: This method is exclusive-only (uses legacy `claimed_by IS NULL` filter).
   * For consensus/unanimous mode, use `claimTaskById` with `exclusive = false`.
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

      // Check if this agent already has a claim for this round (completed or active)
      const existingClaim = this.db.prepare(
        "SELECT 1 FROM task_claims WHERE task_id = ? AND agent_id = ? AND task_status = ?",
      ).get(row.id as string, agentId, status);
      if (existingClaim) return null;

      const now = Date.now();
      // Legacy: keep tasks.claimed_by in sync
      this.db.prepare(
        "UPDATE tasks SET claimed_by = ?, claimed_at = ? WHERE id = ?",
      ).run(agentId, now, row.id as string);
      // Write to task_claims
      this.db.prepare(
        "INSERT OR IGNORE INTO task_claims (task_id, agent_id, task_status, claimed_at) VALUES (?, ?, ?, ?)",
      ).run(row.id as string, agentId, status, now);

      const task = toTask(row);
      task.claimedBy = agentId;
      task.claimedAt = now;
      return task;
    })();
  }

  /**
   * Atomically claim a specific task by ID for an agent.
   * @param exclusive When true (default, "none" mode), only one agent can claim.
   *   When false (consensus modes like "unanimous"), multiple agents can claim the same task.
   */
  claimTaskById(taskId: string, agentId: string, exclusive = true): Task | null {
    return this.db.transaction(() => {
      const task = this.getById(taskId);
      if (!task || task.needsHumanReview) return null;

      const now = Date.now();

      // Check if this agent already has a claim for this round
      const existingClaim = this.db.prepare(
        "SELECT 1 FROM task_claims WHERE task_id = ? AND agent_id = ? AND task_status = ?",
      ).get(taskId, agentId, task.status);
      if (existingClaim) return null;

      // For exclusive mode ("none"): only one agent can claim at a time
      if (exclusive) {
        const otherClaim = this.db.prepare(
          "SELECT 1 FROM task_claims WHERE task_id = ? AND task_status = ? AND completed_at IS NULL",
        ).get(taskId, task.status);
        if (otherClaim) return null;
      }

      // Write to task_claims
      this.db.prepare(
        "INSERT INTO task_claims (task_id, agent_id, task_status, claimed_at) VALUES (?, ?, ?, ?)",
      ).run(taskId, agentId, task.status, now);

      // Legacy: keep tasks.claimed_by in sync
      this.db.prepare(
        "UPDATE tasks SET claimed_by = ?, claimed_at = ? WHERE id = ?",
      ).run(agentId, now, taskId);

      task.claimedBy = agentId;
      task.claimedAt = now;
      return task;
    })();
  }

  /** Release a claimed task so it can be retried. */
  releaseTask(taskId: string): void {
    this.db.transaction(() => {
      this.db.prepare(
        "UPDATE tasks SET claimed_by = NULL, claimed_at = NULL WHERE id = ?",
      ).run(taskId);
      // Remove uncompleted claims for this task
      this.db.prepare(
        "DELETE FROM task_claims WHERE task_id = ? AND completed_at IS NULL",
      ).run(taskId);
    })();
  }

  /**
   * Release claim only when held by the provided agent id.
   * Returns true when a claim was released.
   */
  releaseTaskIfClaimedBy(taskId: string, agentId: string): boolean {
    return this.db.transaction(() => {
      const info = this.db.prepare(
        "UPDATE tasks SET claimed_by = NULL, claimed_at = NULL WHERE id = ? AND claimed_by = ?",
      ).run(taskId, agentId);
      // Remove this agent's uncompleted claim
      this.db.prepare(
        "DELETE FROM task_claims WHERE task_id = ? AND agent_id = ? AND completed_at IS NULL",
      ).run(taskId, agentId);
      return info.changes > 0;
    })();
  }

  /**
   * Release claim and mark it completed atomically. For "none" consensus mode:
   * clears legacy claimed_by and marks the task_claims row as completed.
   * Returns true when the task was finalized by the expected claim owner.
   */
  finalizeClaimedTaskRun(taskId: string, agentId: string): boolean {
    return this.db.transaction(() => {
      const task = this.getById(taskId);
      if (!task) return false;

      const info = this.db.prepare(
        `UPDATE tasks SET claimed_by = NULL, claimed_at = NULL,
                          last_processed_by = ?, last_processed_for_updated_at = updated_at
         WHERE id = ? AND claimed_by = ?`,
      ).run(agentId, taskId, agentId);

      // Mark the claim as completed (without a vote)
      const now = Date.now();
      this.db.prepare(
        "UPDATE task_claims SET completed_at = ? WHERE task_id = ? AND agent_id = ? AND task_status = ? AND completed_at IS NULL",
      ).run(now, taskId, agentId, task.status);

      return info.changes > 0;
    })();
  }

  /** Release claims older than the given cutoff timestamp. Returns count of released claims. */
  cleanupStaleClaims(cutoffTimestamp: number): number {
    return this.db.transaction(() => {
      // Clean up legacy tasks.claimed_by
      const info = this.db.prepare(
        "UPDATE tasks SET claimed_by = NULL, claimed_at = NULL WHERE claimed_by IS NOT NULL AND claimed_at < ?",
      ).run(cutoffTimestamp);
      // Clean up stale task_claims entries (incomplete claims older than cutoff)
      const staleInfo = this.db.prepare(
        "DELETE FROM task_claims WHERE completed_at IS NULL AND claimed_at < ?",
      ).run(cutoffTimestamp);
      if (staleInfo.changes > 0) {
        logger.warn(`Cleaned up ${staleInfo.changes} stale task_claims entries`);
      }
      return info.changes;
    })();
  }

  // --- Task Claims (multi-agent consensus) ---

  /** Create a claim for an agent on a task+status round. Returns true if inserted. */
  createClaim(taskId: string, agentId: string, taskStatus: string): boolean {
    const now = Date.now();
    try {
      this.db.prepare(
        "INSERT INTO task_claims (task_id, agent_id, task_status, claimed_at) VALUES (?, ?, ?, ?)",
      ).run(taskId, agentId, taskStatus, now);
      return true;
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes("UNIQUE constraint")) return false;
      throw err;
    }
  }

  /** Mark a claim as completed with a vote and optional result. */
  completeClaim(taskId: string, agentId: string, taskStatus: string, votedStatus: string | null, result?: string): boolean {
    const now = Date.now();
    const info = this.db.prepare(
      "UPDATE task_claims SET completed_at = ?, voted_status = ?, result = ? WHERE task_id = ? AND agent_id = ? AND task_status = ? AND completed_at IS NULL",
    ).run(now, votedStatus, result ?? null, taskId, agentId, taskStatus);
    return info.changes > 0;
  }

  /** Get all claims for a task+status round. */
  getClaimsForRound(taskId: string, taskStatus: string): TaskClaim[] {
    const rows = this.db.prepare(
      "SELECT * FROM task_claims WHERE task_id = ? AND task_status = ?",
    ).all(taskId, taskStatus) as Record<string, unknown>[];
    return rows.map(toTaskClaim);
  }

  /** Check if an agent has an active (uncompleted) claim for a task+status round. */
  hasActiveClaim(taskId: string, agentId: string, taskStatus: string): boolean {
    const row = this.db.prepare(
      "SELECT 1 FROM task_claims WHERE task_id = ? AND agent_id = ? AND task_status = ? AND completed_at IS NULL",
    ).get(taskId, agentId, taskStatus);
    return !!row;
  }

  /** Check if an agent has any claim (active or completed) for a task+status round. */
  hasClaim(taskId: string, agentId: string, taskStatus: string): boolean {
    const row = this.db.prepare(
      "SELECT 1 FROM task_claims WHERE task_id = ? AND agent_id = ? AND task_status = ?",
    ).get(taskId, agentId, taskStatus);
    return !!row;
  }

  /** Delete all claims for a task+status round (used on status transition). */
  clearClaimsForRound(taskId: string, taskStatus: string): void {
    this.db.prepare(
      "DELETE FROM task_claims WHERE task_id = ? AND task_status = ?",
    ).run(taskId, taskStatus);
  }

  /** Clear all completed claims for a round except for a specific agent. */
  clearCompletedClaimsExcept(taskId: string, taskStatus: string, excludeAgentId: string): void {
    this.db.prepare(
      "DELETE FROM task_claims WHERE task_id = ? AND task_status = ? AND completed_at IS NOT NULL AND agent_id != ?",
    ).run(taskId, taskStatus, excludeAgentId);
  }

  /** Delete all claims for a task (used on human override). */
  clearAllClaimsForTask(taskId: string): void {
    this.db.prepare(
      "DELETE FROM task_claims WHERE task_id = ?",
    ).run(taskId);
  }

  /** Batch-get claims for multiple tasks. Returns Map<taskId, TaskClaim[]>. */
  getClaimsForTasks(taskIds: string[]): Map<string, TaskClaim[]> {
    const result = new Map<string, TaskClaim[]>();
    if (taskIds.length === 0) return result;
    const CLAIMS_CHUNK_SIZE = 500;
    for (let i = 0; i < taskIds.length; i += CLAIMS_CHUNK_SIZE) {
      const chunk = taskIds.slice(i, i + CLAIMS_CHUNK_SIZE);
      const placeholders = chunk.map(() => "?").join(", ");
      const rows = this.db.prepare(
        `SELECT * FROM task_claims WHERE task_id IN (${placeholders})`,
      ).all(...chunk) as Record<string, unknown>[];
      for (const row of rows) {
        const claim = toTaskClaim(row);
        if (!result.has(claim.taskId)) result.set(claim.taskId, []);
        result.get(claim.taskId)!.push(claim);
      }
    }
    return result;
  }

  /** Count active (uncompleted) claims for an agent across all tasks. */
  countActiveClaimsForAgent(agentId: string): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) AS cnt FROM task_claims WHERE agent_id = ? AND completed_at IS NULL",
    ).get(agentId) as { cnt: number };
    return row.cnt;
  }

  /**
   * Check barrier for a consensus round.
   * - "none": resolves as soon as any single agent votes (no consensus needed).
   * - "unanimous": resolves when all agents with claims have voted.
   *   Agents without claims are abstainers (stale claim cleanup removes them).
   */
  private checkBarrier(
    taskId: string,
    taskStatus: string,
    subscribedAgentIds: string[],
    consensus: "none" | "unanimous",
    disagreementTransition?: string,
  ): { resolved: boolean; transition?: string; votes?: Array<{ agentId: string; votedStatus: string }> } {
    if (subscribedAgentIds.length === 0) {
      if (consensus === "unanimous") {
        return { resolved: true, transition: disagreementTransition, votes: [] };
      }
      return { resolved: false };
    }
    const claims = this.getClaimsForRound(taskId, taskStatus);
    const subscribedSet = new Set(subscribedAgentIds);
    const relevantClaims = claims.filter((c) => subscribedSet.has(c.agentId));
    const votedClaims = relevantClaims.filter((c) => c.votedStatus !== null);
    const completedClaims = relevantClaims.filter((c) => c.completedAt !== null);

    if (votedClaims.length === 0) {
      // All-abstention: if every relevant claim completed without voting,
      // resolve via disagreementTransition so the task doesn't get stuck.
      const allSubscribersJoined = relevantClaims.length >= subscribedAgentIds.length;
      const allCompleted = completedClaims.length === relevantClaims.length;
      if (consensus === "unanimous" && allSubscribersJoined && allCompleted) {
        return { resolved: true, transition: disagreementTransition, votes: [] };
      }
      return { resolved: false };
    }

    const votes = votedClaims.map((c) => ({ agentId: c.agentId, votedStatus: c.votedStatus! }));

    // "none": first vote wins (no consensus needed)
    if (consensus === "none") {
      return { resolved: true, transition: votes[0]!.votedStatus, votes };
    }

    // "unanimous": all subscribed agents must have claimed before evaluating
    if (relevantClaims.length < subscribedAgentIds.length) return { resolved: false };
    // All subscribed agents claimed; wait until each has completed (voted or abstained)
    if (completedClaims.length < relevantClaims.length) return { resolved: false };

    // Partial abstention (some voted, some didn't) counts as disagreement
    if (votedClaims.length < relevantClaims.length) {
      return { resolved: true, transition: disagreementTransition, votes };
    }

    const allSame = votes.every((v) => v.votedStatus === votes[0]!.votedStatus);
    if (allSame) {
      return { resolved: true, transition: votes[0]!.votedStatus, votes };
    }
    return { resolved: true, transition: disagreementTransition, votes };
  }

  /**
   * Atomically check a consensus barrier and transition the task if resolved.
   * Wraps the entire check-comment-clear-update sequence in a single transaction
   * to prevent race conditions when multiple agents resolve concurrently.
   * Returns the updated Task if transitioned, null otherwise.
   */
  resolveBarrier(
    taskId: string,
    taskStatus: string,
    subscribedAgentIds: string[],
    consensus: "none" | "unanimous",
    disagreementTransition?: string,
  ): { transition: string; task: Task } | null {
    return this.db.transaction(() => {
      const currentTask = this.getById(taskId);
      if (!currentTask || currentTask.status !== taskStatus) return null;

      // If task is assigned, only the assignee participates in consensus;
      // other subscribers can't claim it so their votes would never arrive.
      const effectiveSubscribers = currentTask.assignee
        ? subscribedAgentIds.filter((id) => id === currentTask.assignee)
        : subscribedAgentIds;

      const barrier = this.checkBarrier(taskId, taskStatus, effectiveSubscribers, consensus, disagreementTransition);
      if (!barrier.resolved) return null;

      const voteLines = (barrier.votes ?? [])
        .map((v) => `  - ${v.agentId} → ${v.votedStatus}`)
        .join("\n");

      if (!barrier.transition) {
        if (consensus !== "none") {
          const votes = barrier.votes ?? [];
          const reason = votes.length === 0
            ? "All agents abstained (completed without voting)."
            : `Agents disagreed but no disagreementTransition configured. Votes:\n${voteLines}`;
          this.addComment(taskId, `[Consensus] Round unresolved — ${reason}\nClearing claims so task can be retried.`, { actor: "system" });
        }
        this.clearClaimsForRound(taskId, taskStatus);
        this.db.prepare("UPDATE tasks SET claimed_by = NULL, claimed_at = NULL WHERE id = ?").run(taskId);
        return null;
      }

      if (consensus !== "none") {
        this.addComment(taskId, `[Consensus] Round resolved. Votes:\n${voteLines}\nTransition: ${barrier.transition}`, { actor: "system" });
      }
      this.clearClaimsForRound(taskId, taskStatus);
      // Clear legacy claimed_by so UI doesn't show stale "working" badge
      this.db.prepare("UPDATE tasks SET claimed_by = NULL, claimed_at = NULL WHERE id = ?").run(taskId);
      const updated = this.update(taskId, { status: barrier.transition }, { clearClaimOnStatusChange: false, updatedBy: "system", skipClaimCleanup: true });
      if (!updated) throw new Error(`Task ${taskId} disappeared during barrier resolution`);
      return { transition: barrier.transition, task: updated };
    })();
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
    } else {
      this.db
        .prepare("UPDATE tasks SET updated_by = ?, updated_at = ? WHERE id = ?")
        .run(updatedBy, updatedAt, taskId);
    }
    // Clear completed claims WITHOUT votes so the task can be re-processed after new human input.
    // Only for human actors — system/agent comments (e.g., [Vote], [Consensus]) must not
    // interfere with in-progress consensus rounds.
    if (updatedBy === HUMAN_TASK_ACTOR) {
      const task = this.getById(taskId);
      if (task) {
        this.db.prepare(
          "DELETE FROM task_claims WHERE task_id = ? AND task_status = ? AND completed_at IS NOT NULL AND voted_status IS NULL",
        ).run(taskId, task.status);
      }
    }
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

/**
 * Resolve a consensus barrier: check votes, add summary comment, clear claims, and transition task.
 * Shared logic used by task_vote, task_update, and worker lifecycle.
 * Returns the transition status if resolved, null otherwise.
 */
export function resolveConsensusBarrier(
  taskStore: TaskStore,
  taskId: string,
  taskStatus: string,
  subscribedAgentIds: string[],
  consensus: "none" | "unanimous",
  disagreementTransition?: string,
): string | null {
  const result = taskStore.resolveBarrier(taskId, taskStatus, subscribedAgentIds, consensus, disagreementTransition);
  if (!result) return null;
  emit("taskChange", { action: "updated", task: result.task });
  return result.transition;
}

function toTaskClaim(row: Record<string, unknown>): TaskClaim {
  return {
    taskId: row.task_id as string,
    agentId: row.agent_id as string,
    taskStatus: row.task_status as string,
    claimedAt: row.claimed_at as number,
    completedAt: row.completed_at != null ? (row.completed_at as number) : null,
    votedStatus: row.voted_status != null ? (row.voted_status as string) : null,
    result: row.result != null ? (row.result as string) : null,
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
