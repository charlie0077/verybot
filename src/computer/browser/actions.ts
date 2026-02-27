/**
 * Thin wrappers around Playwright APIs that use BrowserManager for state.
 * Each action returns a serializable result suitable for tool output.
 */

import { readdirSync } from "node:fs";
import type { BrowserManager } from "./manager.js";
import { buildRoleSnapshotFromAriaSnapshot } from "./snapshot.js";
import { compressScreenshot } from "./screenshot.js";
import { BROWSER_PROFILES_DIR } from "../../paths.js";
import { logger } from "../../logger.js";

const NAVIGATION_TIMEOUT_MS = 30_000;
const ACTION_TIMEOUT_MS = 10_000;
const POST_ACTION_SETTLE_MS = 500;
const POST_KEY_SETTLE_MS = 300;
const TEXT_PREVIEW_LENGTH = 50;

const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

/** Allowed keyboard keys for browser_press_key. */
const ALLOWED_KEYS = new Set([
  "Enter", "Escape", "Tab", "Backspace", "Delete", "Space",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "Home", "End", "PageUp", "PageDown",
  "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
]);

/** Modifier+key pattern (e.g. "Control+A", "Meta+Shift+V"). */
const MODIFIER_KEY_PATTERN = /^(Control|Meta|Alt|Shift)(\+(Control|Meta|Alt|Shift))*\+[A-Za-z0-9]$/;

/** Prefix a tool output string with the active profile name. */
export function withProfilePrefix(browser: BrowserManager, text: string): string {
  return `[profile: ${browser.getActiveProfile()}] ${text}`;
}

/** Navigate to a URL. Returns the page URL + title + snapshot. */
export async function navigate(
  browser: BrowserManager,
  url: string,
  sessionKey?: string,
): Promise<string> {
  // Validate URL scheme to prevent SSRF (file://, javascript:, etc.)
  const parsed = new URL(url);
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    throw new Error(`Unsupported URL scheme: ${parsed.protocol}. Only http and https are allowed.`);
  }

  const page = await browser.launch(sessionKey);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
  const title = await page.title();

  // Auto-snapshot after navigation
  const snapshot = await takeSnapshot(browser, sessionKey);
  return withProfilePrefix(browser, `Navigated to: ${page.url()}\nTitle: ${title}\n\n${snapshot}`);
}

/**
 * Take an a11y snapshot of the current page, assign refs, store them in manager.
 * Returns raw snapshot text without a profile prefix — callers add the prefix.
 */
export async function takeSnapshot(browser: BrowserManager, sessionKey?: string): Promise<string> {
  const page = browser.getPage(sessionKey);
  if (!page) throw new Error("Browser not open. Use browser_navigate first.");

  const ariaText = await page.locator(":root").ariaSnapshot();
  const { snapshot, refs } = buildRoleSnapshotFromAriaSnapshot(ariaText);
  browser.setRoleRefs(refs, sessionKey);

  const refCount = Object.keys(refs).length;
  return `[${page.url()}]\n${snapshot}\n\n(${refCount} refs assigned — use ref like "e1" to interact)`;
}

/** Take a screenshot, compress it, return base64 + mediaType. */
export async function takeScreenshot(
  browser: BrowserManager,
  fullPage?: boolean,
  sessionKey?: string,
): Promise<{ base64: string; mediaType: string }> {
  const page = browser.getPage(sessionKey);
  if (!page) throw new Error("Browser not open. Use browser_navigate first.");

  const png = await page.screenshot({ fullPage: fullPage ?? false });
  return compressScreenshot(Buffer.from(png));
}

/** Click an element by ref. Returns confirmation + auto-snapshot. */
export async function click(
  browser: BrowserManager,
  ref: string,
  sessionKey?: string,
): Promise<string> {
  const locator = browser.refLocator(ref, sessionKey);
  await locator.click({ timeout: ACTION_TIMEOUT_MS });

  // Short wait for navigation/rendering to settle
  const pageAfterClick = browser.getPage(sessionKey);
  if (pageAfterClick) await pageAfterClick.waitForTimeout(POST_ACTION_SETTLE_MS);

  // Auto-snapshot after click
  const snapshot = await takeSnapshot(browser, sessionKey);
  return withProfilePrefix(browser, `Clicked ref=${ref}\n\n${snapshot}`);
}

/** Type text into an input by ref. Optionally submit with Enter. */
export async function type(
  browser: BrowserManager,
  ref: string,
  text: string,
  submit?: boolean,
  sessionKey?: string,
): Promise<string> {
  const locator = browser.refLocator(ref, sessionKey);
  await locator.fill(text, { timeout: ACTION_TIMEOUT_MS });

  if (submit) {
    await locator.press("Enter");
    const pageAfterSubmit = browser.getPage(sessionKey);
    if (pageAfterSubmit) await pageAfterSubmit.waitForTimeout(POST_ACTION_SETTLE_MS);
  }

  // Auto-snapshot after typing
  const snapshot = await takeSnapshot(browser, sessionKey);
  const preview = text.length > TEXT_PREVIEW_LENGTH
    ? `${text.slice(0, TEXT_PREVIEW_LENGTH)}...`
    : text;
  return withProfilePrefix(browser, `Typed "${preview}" into ref=${ref}${submit ? " (submitted)" : ""}\n\n${snapshot}`);
}

/** Press a keyboard key or combo (e.g. "Enter", "Control+A"). */
export async function pressKey(
  browser: BrowserManager,
  key: string,
  sessionKey?: string,
): Promise<string> {
  const page = browser.getPage(sessionKey);
  if (!page) throw new Error("Browser not open. Use browser_navigate first.");

  // Validate key to prevent arbitrary keyboard sequences
  if (!ALLOWED_KEYS.has(key) && !MODIFIER_KEY_PATTERN.test(key)) {
    throw new Error(
      `Key "${key}" is not allowed. Use single keys (Enter, Escape, ArrowDown, Tab, etc.) or modifier combos (Control+A, Meta+C, etc.).`,
    );
  }

  await page.keyboard.press(key);
  await page.waitForTimeout(POST_KEY_SETTLE_MS);

  return withProfilePrefix(browser, `Pressed key: ${key}`);
}

/** Switch the browser to a different named profile. Closes the current browser. */
export async function switchProfile(
  browser: BrowserManager,
  name: string,
): Promise<string> {
  const previous = browser.getActiveProfile();
  await browser.switchProfile(name);
  const profiles = listProfiles();
  return withProfilePrefix(
    browser,
    `Switched from "${previous}" to "${name}". Browser closed — it will relaunch with the new profile on next navigation.\n\nAvailable profiles: ${profiles.join(", ")}`,
  );
}

/** List existing named profiles by reading BROWSER_PROFILES_DIR. */
export function listProfiles(): string[] {
  try {
    const entries = readdirSync(BROWSER_PROFILES_DIR, { withFileTypes: true });
    const profiles = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    // Always include "default" even if dir doesn't exist under profiles/
    if (!profiles.includes("default")) profiles.unshift("default");
    return profiles;
  } catch (err) {
    logger.warn(`Failed to list browser profiles: ${err instanceof Error ? err.message : err}`);
    return ["default"];
  }
}

/** Translate Playwright errors into helpful messages for the agent. */
export function toAIFriendlyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);

  if (msg.includes("Timeout")) {
    return `Action timed out -- the element may not be visible or the page may still be loading. Try taking a fresh snapshot.`;
  }
  if (msg.includes("not attached") || msg.includes("detached")) {
    return `Element is no longer on the page (DOM changed). Take a fresh snapshot and use updated refs.`;
  }
  if (msg.includes("intercepts pointer events") || msg.includes("is not clickable")) {
    return `Element is hidden behind another element. Try scrolling or closing overlays first.`;
  }
  if (msg.includes("Unknown ref") || msg.includes("not allowed") || msg.includes("Unsupported URL") || msg.includes("Profile name")) {
    return msg;
  }

  logger.error(`Browser action error: ${msg}`);
  return `Browser error: ${msg}`;
}
