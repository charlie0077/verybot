/**
 * Browser isolation mode.
 *
 * - "shared": Single BrowserManager, single BrowserContext, all sessions see same pages.
 *   Use for: Single orchestrator, no workers.
 *   Issues: Sessions interfere with each other's tabs.
 *
 * - "per-tab-per-session": Single BrowserManager, single BrowserContext, but each session
 *   tracks its own pages via sessionPages Map. Sessions don't see each other's pages.
 *   Use for: Multiple sessions/workers, most common case.
 *   Advantages: Low overhead, full isolation, backward compatible behavior.
 *
 * - "per-browser-per-session": Each session gets its own BrowserManager with separate
 *   BrowserContext. Maximum isolation, highest resource usage.
 *   Use for: Strict isolation required, separate auth contexts per session.
 *   Advantages: Complete process isolation, separate memory/profiles.
 *   Disadvantages: High memory overhead, slower startup.
 */
export type BrowserMode = "shared" | "per-tab-per-session" | "per-browser-per-session";

export interface BrowserModeOptions {
  // Future: mode-specific configuration options
  // Example: maxPagesPerSession?: number;
  [key: string]: unknown;
}

export interface BrowserModeConfig {
  mode?: BrowserMode;
  modeOptions?: BrowserModeOptions;
}
