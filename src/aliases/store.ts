import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "fs";
import { randomUUID } from "crypto";
import { dirname, join } from "path";
import { logger } from "../logger.js";
import type { CommandAlias } from "./types.js";

/** Max allowed alias length (including leading "/"). */
export const MAX_ALIAS_LENGTH = 64;
/** Max allowed alias expansion length. */
export const MAX_ALIAS_EXPANSION_LENGTH = 2_000;
/** Slash command alias format: "/name" without whitespace. */
const ALIAS_RE = /^\/\S+$/;

function normalizeAlias(rawAlias: string): string {
  const trimmed = rawAlias.trim().toLowerCase();
  if (!trimmed) return "";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function validateAlias(rawAlias: string): string {
  const alias = normalizeAlias(rawAlias);
  if (!alias) throw new Error("alias is required");
  if (alias.length > MAX_ALIAS_LENGTH) {
    throw new Error(`alias exceeds maximum length of ${MAX_ALIAS_LENGTH}`);
  }
  if (!ALIAS_RE.test(alias)) {
    throw new Error("alias must be a single token with no spaces");
  }
  return alias;
}

function validateExpansion(expansion: string): string {
  const trimmed = expansion.trim();
  if (!trimmed) throw new Error("expansion is required");
  if (trimmed.length > MAX_ALIAS_EXPANSION_LENGTH) {
    throw new Error(`expansion exceeds maximum length of ${MAX_ALIAS_EXPANSION_LENGTH}`);
  }
  return trimmed;
}

interface AliasFileData {
  aliases: CommandAlias[];
}

function sortByAlias(a: CommandAlias, b: CommandAlias): number {
  return a.alias.localeCompare(b.alias);
}

/** Global file-backed command alias storage. */
export class CommandAliasStore {
  private readonly filePath: string;
  private aliases = new Map<string, CommandAlias>();
  private lastMtime: number | null = null;

  private constructor(filePath: string) {
    this.filePath = filePath;
    this.aliases = this.loadFromFile();
    this.lastMtime = this.fileMtime();
  }

  static async create(filePath: string): Promise<CommandAliasStore> {
    mkdirSync(dirname(filePath), { recursive: true });
    return new CommandAliasStore(filePath);
  }

  list(): CommandAlias[] {
    this.reloadIfChanged();
    return [...this.aliases.values()]
      .sort(sortByAlias)
      .map((row) => ({ ...row }));
  }

  upsert(rawAlias: string, rawExpansion: string): CommandAlias {
    this.reloadIfChanged();
    const alias = validateAlias(rawAlias);
    const expansion = validateExpansion(rawExpansion);
    const existing = this.aliases.get(alias);
    const now = Date.now();
    const nextAlias: CommandAlias = {
      alias,
      expansion,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.aliases.set(alias, nextAlias);
    this.saveToFile();
    return { ...nextAlias };
  }

  delete(rawAlias: string): boolean {
    this.reloadIfChanged();
    const alias = validateAlias(rawAlias);
    const existed = this.aliases.delete(alias);
    if (existed) this.saveToFile();
    return existed;
  }

  close(): void {
    // no-op: file-backed store
    logger.info("Command alias store closed");
  }

  private loadFromFile(): Map<string, CommandAlias> {
    if (!existsSync(this.filePath)) return new Map();

    try {
      const raw = readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<AliasFileData>;
      const rows = Array.isArray(parsed.aliases) ? parsed.aliases : [];
      const map = new Map<string, CommandAlias>();

      for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        if (typeof row.alias !== "string" || typeof row.expansion !== "string") continue;
        try {
          const alias = validateAlias(row.alias);
          const expansion = validateExpansion(row.expansion);
          const createdAt = Number.isFinite(row.createdAt) ? Number(row.createdAt) : Date.now();
          const updatedAt = Number.isFinite(row.updatedAt) ? Number(row.updatedAt) : createdAt;
          map.set(alias, { alias, expansion, createdAt, updatedAt });
        } catch {
          // Skip malformed alias rows.
        }
      }
      return map;
    } catch (err) {
      logger.warn(`Failed to read command alias file: ${err instanceof Error ? err.message : err}`);
      return new Map();
    }
  }

  private saveToFile(): void {
    const payload: AliasFileData = {
      aliases: [...this.aliases.values()]
        .sort(sortByAlias)
        .map((row) => ({ ...row })),
    };
    const dir = dirname(this.filePath);
    mkdirSync(dir, { recursive: true });

    const tmpPath = join(dir, `.command-aliases.${randomUUID()}.tmp`);
    writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
    renameSync(tmpPath, this.filePath);
    this.lastMtime = this.fileMtime();
  }

  private fileMtime(): number | null {
    try {
      return statSync(this.filePath).mtimeMs;
    } catch {
      return null;
    }
  }

  private reloadIfChanged(): void {
    const mtime = this.fileMtime();
    if (mtime === this.lastMtime) return;
    this.aliases = this.loadFromFile();
    this.lastMtime = mtime;
  }
}
