import { mkdirSync } from "fs";
import { dirname } from "path";
import Database from "better-sqlite3";
import type { MemoryEntry } from "./types.js";
import { logger } from "../logger.js";

const DEFAULT_LIMIT = 10;

export class MemoryStore {
  private db: Database.Database;
  private vectorEnabled = false;
  private vecTableCreated = false;

  private constructor(db: Database.Database) {
    this.db = db;
  }

  /** Async factory — loads sqlite-vec extension if available. */
  static async create(dbPath: string): Promise<MemoryStore> {
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    const store = new MemoryStore(db);
    store.createSchema();
    await store.loadVecExtension();
    return store;
  }

  get hasVectorSearch(): boolean {
    return this.vectorEnabled;
  }

  // --- Schema ---

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        fact TEXT NOT NULL,
        source TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        embedding BLOB
      );
      CREATE INDEX IF NOT EXISTS idx_memories_source ON memories(source);
      CREATE INDEX IF NOT EXISTS idx_memories_timestamp ON memories(timestamp DESC);
    `);

    // FTS5 external content table (synced manually in save/delete, no triggers)
    // Porter tokenizer enables stemming: "like" matches "likes", "running" matches "run"
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        fact,
        content='memories',
        content_rowid='rowid',
        tokenize='porter unicode61'
      );
    `);

    // Idempotent migration: add team_id column for team-scoped memories
    this.migrateTeamId();
  }

  /** Add team_id column if it doesn't exist yet (idempotent). */
  private migrateTeamId(): void {
    const columns = this.db.pragma("table_info(memories)") as Array<{ name: string }>;
    const hasTeamId = columns.some((c) => c.name === "team_id");
    if (!hasTeamId) {
      this.db.exec("ALTER TABLE memories ADD COLUMN team_id TEXT");
      logger.info("Migrated memories table: added team_id column");
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_memories_team_id ON memories(team_id)");
  }

  private async loadVecExtension(): Promise<void> {
    try {
      const sqliteVec = await import("sqlite-vec");
      // Handle both ESM default export and CJS module patterns
      const loader = sqliteVec.default?.load ?? sqliteVec.load;
      loader(this.db);
      this.vectorEnabled = true;

      // Check if vec table already exists from a previous run
      const vecExists = this.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories_vec'")
        .get();
      if (vecExists) this.vecTableCreated = true;

      logger.info(`sqlite-vec extension loaded (vec table: ${this.vecTableCreated ? "exists" : "pending"})`);
    } catch {
      logger.info("sqlite-vec not available — vector search disabled");
    }
  }

  private ensureVecTable(dims: number): void {
    if (this.vecTableCreated || !this.vectorEnabled) return;
    this.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec USING vec0(embedding float[${dims}])`,
    );
    this.vecTableCreated = true;
    logger.info(`Vector table created (${dims} dimensions)`);
  }

  /** Ensure rowid is bound as SQLite INTEGER (BigInt) for sqlite-vec tables. */
  private toSqliteIntegerRowid(value: number | bigint): bigint {
    return typeof value === "bigint" ? value : BigInt(value);
  }

  // --- CRUD ---

  /** Save a memory entry. Returns false if duplicate or near-duplicate fact exists. */
  save(entry: MemoryEntry): boolean {
    // Normalize: trim whitespace and trailing punctuation
    entry = { ...entry, fact: normalizeFact(entry.fact) };

    // Skip exact duplicate (scoped to same team)
    const teamFilter = entry.teamId
      ? "AND team_id = ?"
      : "AND team_id IS NULL";
    const exactParams: unknown[] = entry.teamId
      ? [entry.fact, entry.teamId]
      : [entry.fact];
    const exact = this.db
      .prepare(`SELECT id FROM memories WHERE fact = ? ${teamFilter}`)
      .get(...exactParams);
    if (exact) return false;

    // Skip near-duplicate via FTS5 (e.g. "lives in US" vs "lives in United States")
    // Scope dedup to same team
    const ftsQuery = buildFtsQuery(entry.fact);
    if (ftsQuery) {
      const dedupTeamFilter = entry.teamId
        ? "AND m.team_id = ?"
        : "AND m.team_id IS NULL";
      const dedupParams: unknown[] = entry.teamId
        ? [ftsQuery, entry.source, entry.teamId]
        : [ftsQuery, entry.source];
      const similar = this.db
        .prepare(
          `SELECT m.fact FROM memories_fts f
           JOIN memories m ON m.rowid = f.rowid
           WHERE memories_fts MATCH ? AND m.source = ? ${dedupTeamFilter}
           LIMIT 3`,
        )
        .all(...dedupParams) as Array<{ fact: string }>;
      for (const row of similar) {
        if (isSimilarFact(row.fact, entry.fact)) return false;
      }
    }

    const embeddingBlob = entry.embedding
      ? Buffer.from(new Float32Array(entry.embedding).buffer)
      : null;

    const info = this.db
      .prepare(
        `INSERT INTO memories (id, fact, source, timestamp, embedding, team_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(entry.id, entry.fact, entry.source, entry.timestamp, embeddingBlob, entry.teamId ?? null);

    // Keep as BigInt — better-sqlite3 binds BigInt as INTEGER, but Number as REAL.
    // sqlite-vec rejects REAL primary keys on virtual tables.
    const rowid = this.toSqliteIntegerRowid(info.lastInsertRowid as number | bigint);

    // Sync FTS5 index
    this.db
      .prepare("INSERT INTO memories_fts(rowid, fact) VALUES (?, ?)")
      .run(rowid, entry.fact);

    // Insert into vector table if we have an embedding
    if (this.vectorEnabled && entry.embedding) {
      this.ensureVecTable(entry.embedding.length);
      this.db
        .prepare("INSERT INTO memories_vec (rowid, embedding) VALUES (?, ?)")
        .run(rowid, embeddingBlob);
    }

    return true;
  }

  /** Full-text search using FTS5/BM25. Optionally scoped to a source and/or team. */
  searchByText(query: string, limit = DEFAULT_LIMIT, source?: string, teamId?: string): MemoryEntry[] {
    const ftsQuery = buildFtsQuery(query);
    if (!ftsQuery) return [];

    const conditions = ["memories_fts MATCH ?"];
    const params: unknown[] = [ftsQuery];

    if (source) {
      conditions.push("m.source = ?");
      params.push(source);
    }

    // Team filter: return only team-specific memories
    if (teamId) {
      conditions.push("m.team_id = ?");
      params.push(teamId);
    }

    params.push(limit);

    const rows = this.db
      .prepare(
        `SELECT m.id, m.fact, m.source, m.timestamp, m.team_id, rank
         FROM memories_fts f
         JOIN memories m ON m.rowid = f.rowid
         WHERE ${conditions.join(" AND ")}
         ORDER BY rank
         LIMIT ?`,
      )
      .all(...params) as Array<{ id: string; fact: string; source: string; timestamp: number; team_id: string | null; rank: number }>;

    return rows.map((r) => ({
      id: r.id, fact: r.fact, source: r.source, timestamp: r.timestamp,
      ...(r.team_id ? { teamId: r.team_id } : {}),
    }));
  }

  /** Vector similarity search using sqlite-vec. Optionally scoped to a source and/or team. */
  searchByVector(embedding: number[], limit = DEFAULT_LIMIT, source?: string, teamId?: string): MemoryEntry[] {
    if (!this.vectorEnabled || !this.vecTableCreated) return [];

    const buf = Buffer.from(new Float32Array(embedding).buffer);
    // Fetch more than needed so we can filter by source/team and still fill the limit
    const needsPostFilter = !!source || !!teamId;
    const fetchLimit = needsPostFilter ? limit * 3 : limit;
    const vecRows = this.db
      .prepare("SELECT rowid, distance FROM memories_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?")
      .all(buf, fetchLimit) as Array<{ rowid: number; distance: number }>;

    if (vecRows.length === 0) return [];

    const rowids = vecRows.map((r) => r.rowid);
    const placeholders = rowids.map(() => "?").join(",");

    const conditions = [`rowid IN (${placeholders})`];
    const params: unknown[] = [...rowids];

    if (source) {
      conditions.push("source = ?");
      params.push(source);
    }
    if (teamId) {
      conditions.push("team_id = ?");
      params.push(teamId);
    }

    params.push(limit);

    const memRows = this.db
      .prepare(
        `SELECT id, fact, source, timestamp, team_id FROM memories
         WHERE ${conditions.join(" AND ")}
         LIMIT ?`,
      )
      .all(...params) as Array<{ id: string; fact: string; source: string; timestamp: number; team_id: string | null }>;

    return memRows.map((r) => ({
      id: r.id, fact: r.fact, source: r.source, timestamp: r.timestamp,
      ...(r.team_id ? { teamId: r.team_id } : {}),
    }));
  }

  /** Delete a single memory by its ID. Optionally verify team ownership. Returns true if found and deleted. */
  deleteById(id: string, teamId?: string): boolean {
    // Verify ownership when teamId is provided
    const query = teamId
      ? "SELECT rowid, fact FROM memories WHERE id = ? AND team_id = ?"
      : "SELECT rowid, fact FROM memories WHERE id = ?";
    const params: unknown[] = teamId ? [id, teamId] : [id];
    const row = this.db
      .prepare(query)
      .get(...params) as { rowid: number | bigint; fact: string } | undefined;
    if (!row) return false;

    const doDelete = this.db.transaction(() => {
      // Remove from FTS5 index
      this.db
        .prepare("INSERT INTO memories_fts(memories_fts, rowid, fact) VALUES('delete', ?, ?)")
        .run(this.toSqliteIntegerRowid(row.rowid), row.fact);

      // Remove from vector table
      if (this.vectorEnabled && this.vecTableCreated) {
        this.db
          .prepare("DELETE FROM memories_vec WHERE rowid = ?")
          .run(this.toSqliteIntegerRowid(row.rowid));
      }

      // Remove from main table
      this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
    });
    doDelete();
    return true;
  }

  /**
   * Paginated list of memories for a specific team (or global if teamId is null).
   * Intended for CRUD management (listing/deleting).
   */
  listByTeam(teamId: string | null, limit = DEFAULT_LIMIT, offset = 0): { entries: MemoryEntry[]; total: number } {
    const filter = teamId ? "WHERE team_id = ?" : "WHERE team_id IS NULL";
    const params: unknown[] = teamId ? [teamId] : [];

    const countRow = this.db
      .prepare(`SELECT COUNT(*) AS cnt FROM memories ${filter}`)
      .get(...params) as { cnt: number };

    const rows = this.db
      .prepare(
        `SELECT id, fact, source, timestamp, team_id FROM memories
         ${filter}
         ORDER BY timestamp DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as Array<{ id: string; fact: string; source: string; timestamp: number; team_id: string | null }>;

    return {
      total: countRow.cnt,
      entries: rows.map((r) => ({
        id: r.id, fact: r.fact, source: r.source, timestamp: r.timestamp,
        ...(r.team_id ? { teamId: r.team_id } : {}),
      })),
    };
  }

  /** Delete all memories from a given session source. Returns count deleted. */
  deleteBySource(source: string): number {
    const rows = this.db
      .prepare("SELECT rowid, fact FROM memories WHERE source = ?")
      .all(source) as Array<{ rowid: number | bigint; fact: string }>;
    if (rows.length === 0) return 0;

    const rowids = rows.map((r) => this.toSqliteIntegerRowid(r.rowid));
    const placeholders = rowids.map(() => "?").join(",");

    // Remove from FTS5 index
    for (const row of rows) {
      this.db
        .prepare("INSERT INTO memories_fts(memories_fts, rowid, fact) VALUES('delete', ?, ?)")
        .run(this.toSqliteIntegerRowid(row.rowid), row.fact);
    }

    // Remove from vector table
    if (this.vectorEnabled && this.vecTableCreated) {
      this.db
        .prepare(`DELETE FROM memories_vec WHERE rowid IN (${placeholders})`)
        .run(...rowids);
    }

    // Remove from main table
    const info = this.db
      .prepare(`DELETE FROM memories WHERE rowid IN (${placeholders})`)
      .run(...rowids);
    return info.changes;
  }

  close(): void {
    this.db.close();
    logger.info("Memory store closed");
  }
}

/** Build an FTS5 query from raw text. Returns null if no usable tokens. */
function buildFtsQuery(raw: string): string | null {
  const tokens =
    raw
      .match(/[A-Za-z0-9_]+/g)
      ?.map((t) => t.trim())
      .filter(Boolean) ?? [];
  if (tokens.length === 0) return null;
  // Use OR for broader matching (AND would be too strict for memory recall)
  return tokens.map((t) => `"${t.replaceAll('"', "")}"`).join(" OR ");
}

/** Trim whitespace and trailing punctuation from a fact. */
function normalizeFact(fact: string): string {
  return fact.trim().replace(/[.\s]+$/, "");
}

/** Check if two facts are near-duplicates by comparing their word overlap. */
function isSimilarFact(a: string, b: string): boolean {
  const wordsA = new Set(a.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  const wordsB = new Set(b.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  if (wordsA.size === 0 || wordsB.size === 0) return false;

  let overlap = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) overlap++;
  }

  // If 80%+ of words overlap in both directions, it's a near-duplicate
  const ratioA = overlap / wordsA.size;
  const ratioB = overlap / wordsB.size;
  return ratioA >= 0.8 && ratioB >= 0.8;
}
