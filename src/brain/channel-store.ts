import { randomUUID } from "crypto";
import { mkdirSync } from "fs";
import { dirname } from "path";
import Database from "better-sqlite3";
import { logger } from "../logger.js";

export interface ChannelMessage {
  id: number;
  channelId: string;
  sender: string;
  role: "task" | "result" | "error";
  content: string;
  createdAt: number;
}

/**
 * SQLite-backed ordered message log for inter-agent communication.
 * Each channel is a linear log that any agent (orchestrator or worker) can read/post to.
 */
export class ChannelStore {
  private db: Database.Database;

  private constructor(db: Database.Database) {
    this.db = db;
  }

  static async create(dbPath: string): Promise<ChannelStore> {
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    const store = new ChannelStore(db);
    store.createSchema();
    return store;
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS channel_messages (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id  TEXT NOT NULL,
        sender      TEXT NOT NULL,
        role        TEXT NOT NULL,
        content     TEXT NOT NULL,
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_channel_messages_channel
        ON channel_messages(channel_id, id);
    `);
  }

  /** Create a new channel, returns its UUID. */
  createChannel(): string {
    return randomUUID().slice(0, 12);
  }

  /** Post a message to a channel. Returns the message ID. */
  post(channelId: string, sender: string, role: ChannelMessage["role"], content: string): number {
    const info = this.db
      .prepare(
        `INSERT INTO channel_messages (channel_id, sender, role, content, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(channelId, sender, role, content, Date.now());
    return Number(info.lastInsertRowid);
  }

  /** Read all messages in a channel, ordered by ID. */
  read(channelId: string): ChannelMessage[] {
    const rows = this.db
      .prepare("SELECT * FROM channel_messages WHERE channel_id = ? ORDER BY id")
      .all(channelId) as Record<string, unknown>[];
    return rows.map(toMessage);
  }

  /** Clean up old channel messages older than maxAge ms. */
  cleanup(maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs;
    const info = this.db
      .prepare("DELETE FROM channel_messages WHERE created_at < ?")
      .run(cutoff);
    return info.changes;
  }

  close(): void {
    this.db.close();
    logger.info("Channel store closed");
  }
}

function toMessage(row: Record<string, unknown>): ChannelMessage {
  return {
    id: row.id as number,
    channelId: row.channel_id as string,
    sender: row.sender as string,
    role: row.role as ChannelMessage["role"],
    content: row.content as string,
    createdAt: row.created_at as number,
  };
}
