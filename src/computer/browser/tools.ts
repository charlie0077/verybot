import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { BrowserManager } from "./manager.js";
import { parseRoleRef } from "./snapshot.js";
import * as actions from "./actions.js";

/** Tool names exported for delegate.ts to strip/replace per-worker instances. */
export const BROWSER_TOOL_NAMES = [
  "browser_navigate",
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_press_key",
  "browser_screenshot",
  "browser_close",
  "browser_switch_profile",
];

export function createBrowserTools(browser: BrowserManager, sessionKey?: string): ToolSet {
  return {
    browser_navigate: tool({
      description:
        "Navigate the browser to a URL. Launches the browser if not already open. " +
        "Returns the page title, URL, and an accessibility snapshot with element refs (e1, e2…).",
      inputSchema: z.object({
        url: z.string().url().describe("The URL to navigate to"),
      }),
      execute: async ({ url }) => {
        try {
          return await actions.navigate(browser, url, sessionKey);
        } catch (err) {
          return actions.toAIFriendlyError(err);
        }
      },
    }),

    browser_snapshot: tool({
      description:
        "Take an accessibility snapshot of the current page. Returns the page structure " +
        "with interactive elements labeled with refs (e1, e2…). Use these refs with " +
        "browser_click and browser_type. Always take a fresh snapshot after page changes.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const snapshot = await actions.takeSnapshot(browser, sessionKey);
          return actions.withProfilePrefix(browser, snapshot);
        } catch (err) {
          return actions.toAIFriendlyError(err);
        }
      },
    }),

    browser_click: tool({
      description:
        "Click an element by its ref from the latest snapshot (e.g. 'e5'). " +
        "Automatically takes a new snapshot after clicking so you can see the result.",
      inputSchema: z.object({
        ref: z.string().describe("Element ref from snapshot, e.g. 'e5'"),
      }),
      execute: async ({ ref }) => {
        const parsed = parseRoleRef(ref);
        if (!parsed) return `Invalid ref "${ref}". Use a ref like "e5" from the latest snapshot.`;
        try {
          return await actions.click(browser, parsed, sessionKey);
        } catch (err) {
          return actions.toAIFriendlyError(err);
        }
      },
    }),

    browser_type: tool({
      description:
        "Type text into an input field by its ref from the latest snapshot. " +
        "Clears existing content first (like a user selecting all and typing). " +
        "Set submit=true to press Enter after typing (e.g. for search forms).",
      inputSchema: z.object({
        ref: z.string().describe("Element ref from snapshot, e.g. 'e3'"),
        text: z.string().describe("Text to type into the field"),
        submit: z.boolean().optional().describe("Press Enter after typing (default: false)"),
      }),
      execute: async ({ ref, text, submit }) => {
        const parsed = parseRoleRef(ref);
        if (!parsed) return `Invalid ref "${ref}". Use a ref like "e3" from the latest snapshot.`;
        try {
          return await actions.type(browser, parsed, text, submit, sessionKey);
        } catch (err) {
          return actions.toAIFriendlyError(err);
        }
      },
    }),

    browser_press_key: tool({
      description:
        "Press a keyboard key or combination. Examples: 'Enter', 'Escape', " +
        "'ArrowDown', 'Control+A', 'Meta+C'. Use for keyboard shortcuts and navigation.",
      inputSchema: z.object({
        key: z.string().describe("Key or combination to press, e.g. 'Enter' or 'Control+A'"),
      }),
      execute: async ({ key }) => {
        try {
          return await actions.pressKey(browser, key, sessionKey);
        } catch (err) {
          return actions.toAIFriendlyError(err);
        }
      },
    }),

    browser_screenshot: tool({
      description:
        "Take a screenshot of the current page for visual inspection. " +
        "Returns an image. Use when you need to see the visual layout, " +
        "verify visual changes, or debug rendering issues.",
      inputSchema: z.object({
        fullPage: z.boolean().optional().describe("Capture the full scrollable page (default: false, viewport only)"),
      }),
      execute: async ({ fullPage }) => {
        try {
          const { base64, mediaType } = await actions.takeScreenshot(browser, fullPage, sessionKey);
          return { base64, mediaType };
        } catch (err) {
          return actions.toAIFriendlyError(err);
        }
      },
      toModelOutput({ output }) {
        if (typeof output === "object" && output !== null && "base64" in output) {
          const { base64, mediaType } = output as { base64: string; mediaType: string };
          return {
            type: "content" as const,
            value: [
              {
                type: "image-data" as const,
                data: base64,
                mediaType,
              },
            ],
          };
        }
        return { type: "text" as const, value: String(output) };
      },
    }),

    browser_switch_profile: tool({
      description:
        "Switch the browser to a different named profile. Each profile has its own " +
        "cookies, login state, and extensions. Closes the current browser — it will " +
        "relaunch with the new profile on the next navigation. " +
        "Profile names: letters, digits, and hyphens only (e.g. 'work', 'personal').",
      inputSchema: z.object({
        profile: z.string().describe("Profile name to switch to, e.g. 'work' or 'personal'"),
      }),
      execute: async ({ profile }) => {
        try {
          return await actions.switchProfile(browser, profile);
        } catch (err) {
          return actions.toAIFriendlyError(err);
        }
      },
    }),

    browser_close: tool({
      description: "Close the browser. Use when done with browser tasks.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const profile = browser.getActiveProfile();
          await browser.close();
          return `[profile: ${profile}] Browser closed.`;
        } catch (err) {
          return actions.toAIFriendlyError(err);
        }
      },
    }),
  };
}
