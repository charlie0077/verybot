import { mkdirSync } from "fs";
import { dirname } from "path";
import Database from "better-sqlite3";
import { logger } from "../logger.js";

export type DelegationStatus = "running" | "completed" | "failed";

export interface DelegationRecord {
  id: string;
  agentId: string;
  sessionKey: string;
  task: string;
  channelId: string | null;
  status: DelegationStatus;
  result: string | null;
  error: string | null;
  createdAt: number;
  completedAt: number | null;
}

/**
 * SQLite-backed persistence for delegation tasks.
 * Shares the same DB file as MemoryStore and ScheduleStore.
 */
export class DelegationStore {
  private db: Database.Database;

  private constructor(db: Database.Database) {
    this.db = db;
  }

  static async create(dbPath: string): Promise<DelegationStore> {
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    const store = new DelegationStore(db);
    store.createSchema();
    return store;
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS delegations (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        session_key TEXT NOT NULL,
        task TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        result TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        completed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_delegations_session ON delegations(session_key);
      CREATE INDEX IF NOT EXISTS idx_delegations_status ON delegations(status);
    `);
    // Migration: add channel_id column if missing (graceful for existing DBs)
    try {
      this.db.exec("ALTER TABLE delegations ADD COLUMN channel_id TEXT");
    } catch {
      // Column already exists — ignore
    }
  }

  insert(record: Omit<DelegationRecord, "result" | "error" | "completedAt"> & { status: "running" }): void {
    this.db
      .prepare(
        `INSERT INTO delegations (id, agent_id, session_key, task, channel_id, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(record.id, record.agentId, record.sessionKey, record.task, record.channelId ?? null, record.status, record.createdAt);
  }

  markCompleted(id: string, result: string): void {
    this.db
      .prepare(
        `UPDATE delegations SET status = 'completed', result = ?, completed_at = ? WHERE id = ?`,
      )
      .run(result, Date.now(), id);
  }

  markFailed(id: string, error: string): void {
    this.db
      .prepare(
        `UPDATE delegations SET status = 'failed', error = ?, completed_at = ? WHERE id = ?`,
      )
      .run(error, Date.now(), id);
  }

  getById(id: string): DelegationRecord | null {
    const row = this.db
      .prepare("SELECT * FROM delegations WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? toRecord(row) : null;
  }

  listBySession(sessionKey: string, status?: DelegationStatus): DelegationRecord[] {
    if (status) {
      const rows = this.db
        .prepare("SELECT * FROM delegations WHERE session_key = ? AND status = ? ORDER BY created_at DESC")
        .all(sessionKey, status) as Record<string, unknown>[];
      return rows.map(toRecord);
    }
    const rows = this.db
      .prepare("SELECT * FROM delegations WHERE session_key = ? ORDER BY created_at DESC")
      .all(sessionKey) as Record<string, unknown>[];
    return rows.map(toRecord);
  }

  /** Clean up old completed/failed delegations older than maxAge ms. */
  cleanup(maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs;
    const info = this.db
      .prepare("DELETE FROM delegations WHERE status != 'running' AND completed_at <= ?")
      .run(cutoff);
    return info.changes;
  }

  close(): void {
    this.db.close();
    logger.info("Delegation store closed");
  }
}

function toRecord(row: Record<string, unknown>): DelegationRecord {
  return {
    id: row.id as string,
    agentId: row.agent_id as string,
    sessionKey: row.session_key as string,
    task: row.task as string,
    channelId: (row.channel_id as string) ?? null,
    status: row.status as DelegationStatus,
    result: (row.result as string) ?? null,
    error: (row.error as string) ?? null,
    createdAt: row.created_at as number,
    completedAt: (row.completed_at as number) ?? null,
  };
}
