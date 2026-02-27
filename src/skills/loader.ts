import { watch as chokidarWatch, type FSWatcher } from "chokidar";
import { resolve } from "path";
import type { Tool } from "ai";
import type { SkillEntry } from "./types.js";
import { scanSkills } from "./scanner.js";
import { buildSkillListing } from "./prompt.js";
import { createReadSkillTool } from "./read-tool.js";
import { logger } from "../logger.js";

/** Debounce delay for file watcher to avoid rapid rescans. */
const WATCH_DEBOUNCE_MS = 500;
/** Initial retry delay when watcher fails or directory is missing. */
const WATCH_RETRY_BASE_MS = 2_000;
/** Maximum retry delay (caps exponential backoff). */
const WATCH_RETRY_MAX_MS = 60_000;

/**
 * Manages skills with optional file watching for hot-reload.
 * The Agent reads `systemPrompt` and `readTool` on each run,
 * so changes are picked up automatically.
 */
export class SkillManager {
  private _entries: SkillEntry[] = [];
  private _systemPrompt = "";
  private _readTool: Tool | null = null;
  private watcher: FSWatcher | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryCount = 0;
  private stopped = false;
  private dir: string;

  constructor(dir: string) {
    this.dir = resolve(dir);
  }

  get entries(): SkillEntry[] {
    return this._entries;
  }

  get systemPrompt(): string {
    return this._systemPrompt;
  }

  get readTool(): Tool | null {
    return this._readTool;
  }

  /** Scan the skills directory and update state. */
  async scan(): Promise<void> {
    const entries = await scanSkills(this.dir);
    this._entries = entries;

    if (entries.length === 0) {
      this._systemPrompt = "";
      this._readTool = null;
      return;
    }

    this._systemPrompt = buildSkillListing(entries);
    this._readTool = createReadSkillTool(entries);
    logger.info(`Skills loaded: ${entries.map((s) => s.name).join(", ")}`);
  }

  /** Start watching the skills directory for changes. Retries with backoff if directory is missing. */
  startWatching(): void {
    this.stopped = false;
    this.attemptWatch();
  }

  /** Stop the file watcher and cancel any pending retries. */
  stopWatching(): void {
    this.stopped = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.watcher?.close();
    this.watcher = null;
  }

  private attemptWatch(): void {
    if (this.stopped) return;

    this.watcher?.close();
    this.watcher = null;

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    try {
      this.watcher = chokidarWatch(this.dir, {
        ignoreInitial: true,
        persistent: true,
        depth: 2,
      });
    } catch {
      this.scheduleRetry();
      return;
    }

    const debouncedRescan = (path: string) => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        logger.info(`Skills directory changed (${path}), rescanning...`);
        this.scan().catch((err) => {
          logger.warn(`Skills rescan failed: ${err instanceof Error ? err.message : err}`);
        });
      }, WATCH_DEBOUNCE_MS);
    };

    this.watcher
      .on("add", debouncedRescan)
      .on("change", debouncedRescan)
      .on("unlink", debouncedRescan)
      .on("unlinkDir", debouncedRescan)
      .on("error", (err) => {
        logger.warn(`Skills watcher error: ${err instanceof Error ? err.message : err}`);
        this.scheduleRetry();
      });

    this.retryCount = 0;
    logger.info(`Watching skills directory: ${this.dir}`);
  }

  private scheduleRetry(): void {
    if (this.stopped) return;

    this.watcher?.close();
    this.watcher = null;

    const delay = Math.min(WATCH_RETRY_BASE_MS * 2 ** this.retryCount, WATCH_RETRY_MAX_MS);
    this.retryCount++;

    logger.info(`Skills watcher will retry in ${delay / 1000}s (attempt ${this.retryCount})`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.scan()
        .catch((err) => {
          logger.warn(`Skills rescan on retry failed: ${err instanceof Error ? err.message : err}`);
        })
        .finally(() => this.attemptWatch());
    }, delay);
  }
}

/**
 * Load skills from the given directory and start watching for changes.
 */
export async function loadSkills(dir: string): Promise<SkillManager> {
  const manager = new SkillManager(dir);
  await manager.scan();
  manager.startWatching();
  return manager;
}
