import { mkdirSync } from "fs";
import { dirname } from "path";
import { randomUUID } from "crypto";
import Database from "better-sqlite3";
import { logger } from "../logger.js";
import type { PromptTemplate } from "./types.js";

/** Max allowed length for template names. */
export const MAX_TEMPLATE_NAME_LENGTH = 128;
/** Max allowed length for template content. */
export const MAX_TEMPLATE_CONTENT_LENGTH = 50_000;

const VALID_ROLES = new Set(["orchestrator", "worker"]);
const FORK_NAME_SUFFIX = "Copy";
const FIRST_FORK_DUPLICATE_INDEX = 2;

export interface CreatePromptTemplateInput {
  id?: string;
  name: string;
  description?: string;
  role: "orchestrator" | "worker";
  content: string;
}

export interface UpdatePromptTemplateInput {
  name?: string;
  description?: string;
  role?: "orchestrator" | "worker";
  content?: string;
}

export interface ForkPromptTemplateInput {
  name?: string;
  description?: string;
}

/**
 * SQLite-backed persistence for prompt templates.
 * Shares the same DB file as TeamStore, TaskStore, etc.
 */
export class PromptTemplateStore {
  private db: Database.Database;

  private constructor(db: Database.Database) {
    this.db = db;
  }

  static async create(dbPath: string): Promise<PromptTemplateStore> {
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    const store = new PromptTemplateStore(db);
    store.createSchema();
    return store;
  }

  private createSchema(): void {
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS prompt_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        role TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        builtin INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  createPromptTemplate(input: CreatePromptTemplateInput): PromptTemplate {
    validateName(input.name);
    validateContent(input.content);
    validateRole(input.role);

    const now = Date.now();
    const id = input.id ?? randomUUID();
    try {
      this.db.prepare(
        `INSERT INTO prompt_templates (id, name, description, role, content, builtin, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
      ).run(id, input.name, input.description ?? "", input.role, input.content, now, now);
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes("UNIQUE constraint")) {
        throw new Error(`A template named "${input.name}" already exists`);
      }
      throw err;
    }
    return {
      id, name: input.name, description: input.description ?? "",
      role: input.role, content: input.content, builtin: false,
      createdAt: now, updatedAt: now,
    };
  }

  forkPromptTemplate(sourceId: string, input: ForkPromptTemplateInput = {}): PromptTemplate | null {
    const source = this.getPromptTemplateById(sourceId);
    if (!source) return null;

    const name = input.name === undefined
      ? buildForkName(source.name, this.listPromptTemplateNames())
      : input.name.trim();

    return this.createPromptTemplate({
      name,
      description: input.description ?? source.description,
      role: source.role,
      content: source.content,
    });
  }

  updatePromptTemplate(id: string, input: UpdatePromptTemplateInput): PromptTemplate | null {
    const existing = this.getPromptTemplateById(id);
    if (!existing) return null;
    if (existing.builtin) throw new Error("Cannot modify a built-in template");

    if (input.name !== undefined) validateName(input.name);
    if (input.content !== undefined) validateContent(input.content);
    if (input.role !== undefined) validateRole(input.role);

    const now = Date.now();
    const updated: PromptTemplate = {
      ...existing,
      ...(input.name !== undefined && { name: input.name }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.role !== undefined && { role: input.role }),
      ...(input.content !== undefined && { content: input.content }),
      updatedAt: now,
    };
    try {
      this.db.prepare(
        `UPDATE prompt_templates SET name = ?, description = ?, role = ?, content = ?, updated_at = ? WHERE id = ?`,
      ).run(updated.name, updated.description, updated.role, updated.content, now, id);
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes("UNIQUE constraint")) {
        throw new Error(`A template named "${input.name}" already exists`);
      }
      throw err;
    }
    return updated;
  }

  deletePromptTemplate(id: string): boolean {
    const existing = this.getPromptTemplateById(id);
    if (existing?.builtin) throw new Error("Cannot delete a built-in template");
    const info = this.db.prepare("DELETE FROM prompt_templates WHERE id = ?").run(id);
    return info.changes > 0;
  }

  getPromptTemplateById(id: string): PromptTemplate | null {
    const row = this.db.prepare("SELECT * FROM prompt_templates WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? toPromptTemplate(row) : null;
  }

  listPromptTemplates(): PromptTemplate[] {
    const rows = this.db.prepare("SELECT * FROM prompt_templates ORDER BY builtin DESC, created_at ASC").all() as Record<string, unknown>[];
    return rows.map(toPromptTemplate);
  }

  private listPromptTemplateNames(): string[] {
    const rows = this.db.prepare("SELECT name FROM prompt_templates").all() as Array<{ name: string }>;
    return rows.map((row) => row.name);
  }

  /**
   * Upsert built-in templates by id on boot.
   * Only updates name/description/role/content for existing builtins.
   */
  seedBuiltins(templates: Omit<PromptTemplate, "createdAt" | "updatedAt">[]): void {
    const upsert = this.db.prepare(`
      INSERT INTO prompt_templates (id, name, description, role, content, builtin, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        role = excluded.role,
        content = excluded.content,
        builtin = 1,
        updated_at = excluded.updated_at
    `);
    const now = Date.now();
    const keepIds = templates.map((t) => t.id);
    const runAll = this.db.transaction(() => {
      for (const t of templates) {
        upsert.run(t.id, t.name, t.description, t.role, t.content, now, now);
      }
      if (keepIds.length === 0) {
        this.db.prepare(`DELETE FROM prompt_templates WHERE builtin = 1`).run();
      } else {
        this.db.prepare(
          `DELETE FROM prompt_templates WHERE builtin = 1 AND id NOT IN (${keepIds.map(() => "?").join(",")})`,
        ).run(...keepIds);
      }
    });
    runAll();
    logger.info(`Seeded ${templates.length} built-in prompt templates`);
  }

  close(): void {
    this.db.close();
    logger.info("Prompt template store closed");
  }
}

function toPromptTemplate(row: Record<string, unknown>): PromptTemplate {
  return {
    id: row.id as string,
    name: row.name as string,
    description: (row.description as string) ?? "",
    role: row.role as "orchestrator" | "worker",
    content: (row.content as string) ?? "",
    builtin: (row.builtin as number) === 1,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

function validateName(name: string): void {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new Error("Template name is required");
  }
  if (name.length > MAX_TEMPLATE_NAME_LENGTH) {
    throw new Error(`Template name exceeds maximum length of ${MAX_TEMPLATE_NAME_LENGTH}`);
  }
}

function validateContent(content: string): void {
  if (typeof content !== "string") {
    throw new Error("Template content must be a string");
  }
  if (content.length > MAX_TEMPLATE_CONTENT_LENGTH) {
    throw new Error(`Template content exceeds maximum length of ${MAX_TEMPLATE_CONTENT_LENGTH}`);
  }
}

function validateRole(role: string): void {
  if (!VALID_ROLES.has(role)) {
    throw new Error("role must be 'orchestrator' or 'worker'");
  }
}

function buildForkName(sourceName: string, existingNames: string[]): string {
  const trimmedSourceName = sourceName.trim();
  const firstForkName = `${trimmedSourceName} (${FORK_NAME_SUFFIX})`;
  const existing = new Set(existingNames);
  if (!existing.has(firstForkName)) return firstForkName;

  const escapedName = escapeRegex(trimmedSourceName);
  const forkPattern = new RegExp(`^${escapedName} \\(${FORK_NAME_SUFFIX}(?: (\\d+))?\\)$`);
  let nextIndex = FIRST_FORK_DUPLICATE_INDEX;

  for (const candidateName of existing) {
    const match = candidateName.match(forkPattern);
    if (!match) continue;
    const usedIndex = match[1] ? Number(match[1]) : 1;
    if (!Number.isFinite(usedIndex)) continue;
    nextIndex = Math.max(nextIndex, usedIndex + 1);
  }

  return `${trimmedSourceName} (${FORK_NAME_SUFFIX} ${nextIndex})`;
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
