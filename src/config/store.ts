import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { logger } from "../logger.js";

/** Patterns that identify sensitive config keys by name. */
const SENSITIVE_PATTERNS = [/token/i, /password/i, /secret/i, /api.?key/i];

/** Check whether a config key name looks sensitive. */
function isSensitiveKey(key: string): boolean {
  return SENSITIVE_PATTERNS.some((p) => p.test(key));
}

/** Minimum chars to show prefix/suffix in redaction. */
const REDACT_MIN_LENGTH = 10;
const REDACT_PREFIX = 6;
const REDACT_SUFFIX = 4;
const REDACT_MARKER = "...";

export type ConfigData = Record<string, unknown>;

/**
 * Manages a single `config.json` file on disk.
 * Handles reading, writing, patching, and redaction of secret values.
 */
export class ConfigStore {
  private filePath: string;

  constructor(baseDir: string) {
    this.filePath = join(baseDir, "config.json");
  }

  /** Read config from disk. Returns empty object if file doesn't exist. */
  load(): ConfigData {
    try {
      if (!existsSync(this.filePath)) return {};
      const raw = readFileSync(this.filePath, "utf-8");
      return JSON.parse(raw);
    } catch (err) {
      logger.warn(`Failed to read config.json: ${err instanceof Error ? err.message : err}`);
      return {};
    }
  }

  /** Write full config to disk atomically (temp file → rename). */
  save(data: ConfigData): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const tmp = join(tmpdir(), `config-${randomUUID()}.json`);
    writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
    renameSync(tmp, this.filePath);
    logger.info(`Config saved to ${this.filePath}`);
  }

  /** Deep-merge a partial update into the existing config and save. */
  patch(partial: ConfigData): ConfigData {
    const existing = this.load();
    const merged = deepMerge(existing, partial);
    this.save(merged);
    return merged;
  }

  /** Return config with secret values redacted. */
  getRedacted(): ConfigData {
    const data = this.load();
    return redactSecrets(data);
  }

  /**
   * Given an incoming config (possibly with redacted values from the UI),
   * restore redacted secrets from the existing disk values before saving.
   */
  patchFromUI(incoming: ConfigData): ConfigData {
    const existing = this.load();
    const restored = restoreRedacted(incoming, existing);
    return this.patch(restored);
  }

  /** Return file mtime in ms, or null if file doesn't exist. */
  mtime(): number | null {
    try {
      return statSync(this.filePath).mtimeMs;
    } catch {
      return null;
    }
  }

  getFilePath(): string {
    return this.filePath;
  }
}

/** Redact secret values in a config object. */
function redactSecrets(data: ConfigData): ConfigData {
  const result = { ...data };
  for (const key of Object.keys(result)) {
    if (isSensitiveKey(key) && typeof result[key] === "string") {
      result[key] = redactValue(result[key] as string);
    }
  }
  return result;
}

/** Mask a secret string: show prefix...suffix for long values, **** for short ones. */
function redactValue(value: string): string {
  if (!value) return "";
  if (value.length < REDACT_MIN_LENGTH) return "****";
  return (
    value.slice(0, REDACT_PREFIX) + REDACT_MARKER + value.slice(-REDACT_SUFFIX)
  );
}

/**
 * If a value in `incoming` looks like it's still redacted (matches the pattern
 * from `redactValue`), replace it with the original from `existing`.
 */
function restoreRedacted(incoming: ConfigData, existing: ConfigData): ConfigData {
  const result = { ...incoming };
  for (const key of Object.keys(result)) {
    if (!isSensitiveKey(key)) continue;
    const inVal = result[key];
    const exVal = existing[key];
    if (typeof inVal !== "string" || typeof exVal !== "string") continue;

    // If the incoming value matches the redacted form of the existing value, keep existing
    if (inVal === redactValue(exVal)) {
      result[key] = exVal;
    }
  }
  return result;
}

/** Keys that should be replaced wholesale instead of deep-merged. */
const REPLACE_KEYS = new Set(["mcpServers"]);

/** Simple deep merge: objects are merged recursively, primitives/arrays are overwritten. */
function deepMerge(target: ConfigData, source: ConfigData): ConfigData {
  const result: ConfigData = { ...target };
  for (const [key, val] of Object.entries(source)) {
    if (REPLACE_KEYS.has(key)) {
      result[key] = val;
    } else if (
      val !== null &&
      typeof val === "object" &&
      !Array.isArray(val) &&
      typeof result[key] === "object" &&
      result[key] !== null &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(result[key] as ConfigData, val as ConfigData);
    } else {
      result[key] = val;
    }
  }
  return result;
}
