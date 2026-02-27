import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright-extra";
import type { BrowserContext, Page } from "playwright";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { BROWSER_PROFILE_DIR, BROWSER_PROFILES_DIR } from "../../paths.js";
import { logger } from "../../logger.js";
import { buildProfileBadgeScript } from "./profile-badge.js";
import type { RoleRefMap, RoleRef } from "./snapshot.js";
import type { BrowserMode, BrowserModeConfig } from "./types.js";

// Guard against double-registration (e.g. test runners that re-evaluate modules).
let stealthApplied = false;
function ensureStealth() {
  if (stealthApplied) return;
  chromium.use(StealthPlugin());
  stealthApplied = true;
}

const DEFAULT_PROFILE = "default";
const PROFILE_NAME_MAX_LENGTH = 50;
const PROFILE_NAME_PATTERN = /^[a-zA-Z0-9-]+$/;

/** Chromium launch flags: automation-control hiding + clean launch defaults. */
const LAUNCH_ARGS = [
  "--disable-blink-features=AutomationControlled",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-component-update",
];

/** Validate a profile name. Throws on invalid input. */
export function validateProfileName(name: string): void {
  if (!name || name.length > PROFILE_NAME_MAX_LENGTH) {
    throw new Error(
      `Profile name must be 1-${PROFILE_NAME_MAX_LENGTH} characters. Got: "${name}"`,
    );
  }
  if (!PROFILE_NAME_PATTERN.test(name)) {
    throw new Error(
      `Profile name may only contain letters, digits, and hyphens. Got: "${name}"`,
    );
  }
}

export interface BrowserConfig extends BrowserModeConfig {
  headless?: boolean;
  /**
   * Chrome user-data-dir.
   * - `undefined` (default): uses the shared persistent profile (`BROWSER_PROFILE_DIR`).
   * - `"temp"`: creates a fresh temp dir per launch (used for worker isolation).
   * - any other string: uses that path as-is.
   */
  profileDir?: string | "temp";
  /** Named profile (e.g. "work", "personal"). Default: "default". */
  profile?: string;
  /** Custom User-Agent string. When unset, auto-detects a clean UA from the real browser. */
  userAgent?: string;
}

export class BrowserManager {
  private static cachedCleanUAByMode: Map<string, string> = new Map();
  private context: BrowserContext | null = null;
  private config: BrowserConfig;
  private roleRefs: RoleRefMap = {};
  private sessionRoleRefs: Map<string, RoleRefMap> = new Map();
  private activeProfile: string;
  private tempProfileDir: string | null = null;

  // NEW: Session-aware page tracking (for per-tab mode)
  private sessionPages: Map<string, Page[]> = new Map();
  private currentSessionKey: string | null = null;

  constructor(config: BrowserConfig) {
    this.config = config;
    const profile = config.profile ?? DEFAULT_PROFILE;
    if (profile !== DEFAULT_PROFILE) validateProfileName(profile);
    this.activeProfile = profile;
  }

  private isPerTabMode(): boolean {
    return this.config.mode === "per-tab-per-session";
  }

  private resolveSessionKey(sessionKey?: string | null): string | null {
    return sessionKey ?? this.currentSessionKey;
  }

  private ensureSessionPages(sessionKey: string): Page[] {
    const existing = this.sessionPages.get(sessionKey);
    if (existing) return existing;
    const created: Page[] = [];
    this.sessionPages.set(sessionKey, created);
    return created;
  }

  private trackPageForSession(page: Page, sessionKey: string): void {
    const pages = this.ensureSessionPages(sessionKey);
    if (!pages.includes(page)) pages.push(page);
    page.once("close", () => {
      const ownedPages = this.sessionPages.get(sessionKey);
      if (!ownedPages) return;
      const idx = ownedPages.indexOf(page);
      if (idx !== -1) ownedPages.splice(idx, 1);
      if (ownedPages.length === 0) this.sessionPages.delete(sessionKey);
    });
  }

  private pruneClosedPages(sessionKey: string): void {
    const pages = this.sessionPages.get(sessionKey);
    if (!pages) return;
    const openPages = pages.filter((p) => !p.isClosed());
    if (openPages.length === 0) {
      this.sessionPages.delete(sessionKey);
      return;
    }
    if (openPages.length !== pages.length) this.sessionPages.set(sessionKey, openPages);
  }

  /**
   * Set the current session key for page tracking (per-tab-per-session mode).
   * Called by buildRunTools() to bind tools to a specific session.
   */
  setSessionKey(key: string | null): void {
    this.currentSessionKey = key;
  }

  /**
   * Get the current session key (if set).
   */
  getSessionKey(): string | null {
    return this.currentSessionKey;
  }

  /**
   * MODIFIED: launch() now session-aware
   * If mode is "per-tab-per-session" and sessionKey is set,
   * pages are tracked per session.
   */
  async launch(sessionKey?: string): Promise<Page> {
    ensureStealth();
    const key = this.resolveSessionKey(sessionKey);
    if (this.context) {
      // Per-tab mode: check session-specific pages first
      if (
        this.isPerTabMode() &&
        key
      ) {
        this.pruneClosedPages(key);
        const sessionPageList = this.sessionPages.get(key) ?? [];
        if (sessionPageList.length > 0) {
          return sessionPageList[sessionPageList.length - 1];
        }
        const newPage = await this.context.newPage();
        this.trackPageForSession(newPage, key);
        return newPage;
      }

      // Shared/per-browser mode: keep using the active page when available.
      const pages = this.context.pages();
      const current = pages[pages.length - 1];
      if (current && !current.isClosed()) return current;
      return await this.context.newPage();
    }

    // ... rest of launch() logic unchanged
    const isTemp = this.config.profileDir === "temp";
    const profileDir = isTemp
      ? mkdtempSync(join(tmpdir(), "verybot-browser-"))
      : this.resolveProfileDir();
    this.tempProfileDir = isTemp ? profileDir : null;

    const headless = this.config.headless ?? true;
    const userAgent = this.config.userAgent ?? (await this.detectCleanUA(headless));

    const isMac = process.platform === "darwin";
    const deviceScaleFactor = isMac ? 2 : 1;
    const viewport = { width: isMac ? 1512 : 1920, height: isMac ? 982 : 1080 };

    // Always set a clean UA on persistent-context launch to cover the first page.
    this.context = await chromium.launchPersistentContext(profileDir, {
      headless,
      viewport,
      deviceScaleFactor,
      userAgent,
      args: LAUNCH_ARGS,
    });

    if (!isTemp) {
      await this.context.addInitScript(buildProfileBadgeScript(this.activeProfile));
    }

    logger.info(
      `Browser launched (profile: ${this.activeProfile}, mode: ${this.config.mode ?? "shared"})`
    );

    const pages = this.context.pages();
    const page = pages[pages.length - 1] ?? (await this.context.newPage());
    if (this.isPerTabMode() && key) {
      this.trackPageForSession(page, key);
    }
    return page;
  }

  /**
   * Probe-launch Chromium once per mode to derive a stable UA without "HeadlessChrome".
   * This protects the initial page in persistent contexts where plugin hooks may not run yet.
   */
  private async detectCleanUA(headless: boolean): Promise<string> {
    const cacheKey = headless ? "headless" : "headful";
    const cachedUA = BrowserManager.cachedCleanUAByMode.get(cacheKey);
    if (cachedUA) return cachedUA;

    const probeProfileDir = mkdtempSync(join(tmpdir(), "verybot-browser-ua-probe-"));
    const probeContext = await chromium.launchPersistentContext(probeProfileDir, {
      headless,
      args: ["--no-first-run"],
    });

    try {
      const probePage = probeContext.pages()[0] ?? (await probeContext.newPage());
      const rawUA = await probePage.evaluate(() => navigator.userAgent);
      const cleanUA = rawUA.replace(/HeadlessChrome/g, "Chrome");
      BrowserManager.cachedCleanUAByMode.set(cacheKey, cleanUA);
      return cleanUA;
    } finally {
      await probeContext.close();
      if (existsSync(probeProfileDir)) {
        rmSync(probeProfileDir, { recursive: true, force: true });
      }
    }
  }

  /** Resolve the user-data directory for the active named profile. */
  private resolveProfileDir(): string {
    if (this.config.profileDir && this.config.profileDir !== "temp") {
      return this.config.profileDir;
    }
    // Named profile → dedicated subdirectory under BROWSER_PROFILES_DIR
    if (this.activeProfile !== DEFAULT_PROFILE) {
      const dir = join(BROWSER_PROFILES_DIR, this.activeProfile);
      mkdirSync(dir, { recursive: true });
      return dir;
    }
    // Default profile → legacy shared dir
    return BROWSER_PROFILE_DIR;
  }

  /** Close current browser and switch to a different named profile. */
  async switchProfile(name: string): Promise<void> {
    validateProfileName(name);
    await this.close();
    this.activeProfile = name;
    logger.info(`Switched to browser profile: ${name}`);
  }

  /** Get the currently active profile name. */
  getActiveProfile(): string {
    return this.activeProfile;
  }

  /** Update config for next browser launch. Closes existing browser if headless mode changed. */
  async updateConfig(config: BrowserConfig): Promise<void> {
    const headlessChanged = this.context && (config.headless ?? true) !== (this.config.headless ?? true);
    this.config = { ...this.config, ...config };
    if (headlessChanged) {
      logger.info("Headless mode changed — closing browser so next launch uses new setting");
      await this.close();
    }
  }

  /**
   * MODIFIED: getPage() respects session boundary in per-tab mode
   */
  getPage(sessionKey?: string): Page | null {
    if (!this.context) return null;
    const key = this.resolveSessionKey(sessionKey);

    // Per-tab mode: return session's own page
    if (
      this.isPerTabMode() &&
      key
    ) {
      this.pruneClosedPages(key);
      const pages = this.sessionPages.get(key) ?? [];
      return pages.length > 0 ? pages[pages.length - 1] : null;
    }

    // Shared mode or no session key: return last page globally
    const pages = this.context.pages();
    return pages[pages.length - 1] ?? null;
  }

  /** Check if the browser is currently launched. */
  isLaunched(): boolean {
    return this.context !== null;
  }

  /** Store role refs from the latest snapshot. */
  setRoleRefs(refs: RoleRefMap, sessionKey?: string): void {
    const key = this.resolveSessionKey(sessionKey);
    if (this.isPerTabMode() && key) {
      this.sessionRoleRefs.set(key, refs);
      return;
    }
    this.roleRefs = refs;
  }

  /** Get stored role refs from the latest snapshot. */
  getRoleRefs(sessionKey?: string): RoleRefMap {
    const key = this.resolveSessionKey(sessionKey);
    if (this.isPerTabMode() && key) {
      return this.sessionRoleRefs.get(key) ?? {};
    }
    return this.roleRefs;
  }

  /**
   * Resolve a ref string (e.g. "e5") to a Playwright Locator.
   * Ported from main project's pw-session.ts:refLocator.
   */
  refLocator(ref: string, sessionKey?: string) {
    const page = this.getPage(sessionKey);
    if (!page) throw new Error("Browser not launched. Use browser_navigate first.");

    const normalized = ref.startsWith("@")
      ? ref.slice(1)
      : ref.startsWith("ref=")
        ? ref.slice(4)
        : ref;

    const refs = this.getRoleRefs(sessionKey);
    const info: RoleRef | undefined = refs[normalized];
    if (!info) {
      throw new Error(
        `Unknown ref "${normalized}". Take a new snapshot and use a ref from that snapshot.`,
      );
    }

    const locator = info.name
      ? page.getByRole(info.role as never, { name: info.name, exact: true })
      : page.getByRole(info.role as never);
    return info.nth !== undefined ? locator.nth(info.nth) : locator;
  }

  /**
   * NEW: Get all pages for a session (useful for debugging/cleanup).
   */
  getSessionPages(sessionKey: string): Page[] {
    return this.sessionPages.get(sessionKey) ?? [];
  }

  /**
   * MODIFIED: close() now clears session page tracking
   */
  async close(): Promise<void> {
    if (this.context) {
      await this.context.close();
      this.context = null;
    }
    this.roleRefs = {};
    this.sessionRoleRefs.clear();
    this.sessionPages.clear();  // NEW
    this.currentSessionKey = null;  // NEW
    if (this.tempProfileDir) {
      try {
        if (existsSync(this.tempProfileDir)) {
          rmSync(this.tempProfileDir, { recursive: true, force: true });
        }
      } catch (err) {
        logger.warn(`Failed to remove temp browser profile dir ${this.tempProfileDir}: ${err}`);
      } finally {
        this.tempProfileDir = null;
      }
    }
    logger.info("Browser closed");
  }

  /**
   * NEW: Clear pages for a specific session (called on session cleanup)
   */
  async clearSessionPages(sessionKey: string): Promise<void> {
    const pages = this.sessionPages.get(sessionKey);
    this.sessionRoleRefs.delete(sessionKey);
    if (!pages) return;

    // Close all pages for this session
    for (const page of [...pages]) {
      try {
        await page.close();
      } catch (err) {
        logger.warn(`Failed to close page during session cleanup: ${err}`);
      }
    }

    this.sessionPages.delete(sessionKey);
    if (this.currentSessionKey === sessionKey) this.currentSessionKey = null;
  }
}
