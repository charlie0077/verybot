/**
 * Tests for browser mode support in BrowserManager.
 */

import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { chromium } from "playwright-extra";
import { BrowserManager } from "../manager.js";
import {
  getBrowserManager,
  releaseBrowserManager,
  getActiveSessions,
  getBrowserStats,
} from "../context-manager.js";
import type { BrowserConfig } from "../manager.js";
import type { BrowserContext, Page } from "playwright";

describe("BrowserManager - Browser Mode Support", () => {
  function makeFakePage(): Page {
    let closed = false;
    const closeHandlers: Array<() => void> = [];
    return {
      once: (event: string, handler: () => void) => {
        if (event === "close") closeHandlers.push(handler);
      },
      close: async () => {
        if (closed) return;
        closed = true;
        for (const handler of closeHandlers) handler();
      },
      isClosed: () => closed,
    } as unknown as Page;
  }

  function makeFakeContext(newPage: Page, pages: Page[] = []): BrowserContext {
    return {
      pages: () => pages,
      newPage: async () => newPage,
    } as unknown as BrowserContext;
  }

  describe("session key management", () => {
    it("should initialize with no session key by default", () => {
      const manager = new BrowserManager({});
      expect(manager.getSessionKey()).toBeNull();
    });

    it("should set and get session key", () => {
      const manager = new BrowserManager({});
      manager.setSessionKey("test-session-1");
      expect(manager.getSessionKey()).toBe("test-session-1");
    });

    it("should allow clearing session key", () => {
      const manager = new BrowserManager({});
      manager.setSessionKey("test-session-2");
      manager.setSessionKey(null);
      expect(manager.getSessionKey()).toBeNull();
    });
  });

  describe("session page isolation", () => {
    it("should return empty array for session pages when browser not launched", () => {
      const manager = new BrowserManager({});
      manager.setSessionKey("test-session-3");
      expect(manager.getSessionPages("test-session-3")).toEqual([]);
    });

    it("should track different pages for different sessions", () => {
      const manager1 = new BrowserManager({ mode: "per-tab-per-session" });
      manager1.setSessionKey("session-1");

      const manager2 = new BrowserManager({ mode: "per-tab-per-session" });
      manager2.setSessionKey("session-2");

      expect(manager1.getSessionKey()).toBe("session-1");
      expect(manager2.getSessionKey()).toBe("session-2");
    });

    it("launch(sessionKey) should track pages for the explicit session key", async () => {
      const manager = new BrowserManager({ mode: "per-tab-per-session" });
      manager.setSessionKey("session-a");

      const page = makeFakePage();
      (manager as unknown as { context: BrowserContext | null }).context = makeFakeContext(page);

      await manager.launch("session-b");

      expect(manager.getSessionPages("session-a")).toEqual([]);
      expect(manager.getSessionPages("session-b")).toHaveLength(1);
    });

    it("launch(sessionKey) should reuse tracked page for that session", async () => {
      const manager = new BrowserManager({ mode: "per-tab-per-session" });

      const page = makeFakePage();
      (manager as unknown as { context: BrowserContext | null }).context = makeFakeContext(page);

      const first = await manager.launch("owner-session");
      const second = await manager.launch("owner-session");

      expect(first).toBe(page);
      expect(second).toBe(page);
      expect(manager.getSessionPages("owner-session")).toHaveLength(1);
    });

    it("page close cleanup should remove page from the owning session", async () => {
      const manager = new BrowserManager({ mode: "per-tab-per-session" });

      const page = makeFakePage();
      (manager as unknown as { context: BrowserContext | null }).context = makeFakeContext(page);

      await manager.launch("owner-session");
      manager.setSessionKey("other-session");
      await page.close();

      expect(manager.getSessionPages("owner-session")).toEqual([]);
      expect(manager.getSessionPages("other-session")).toEqual([]);
    });
  });

  describe("role refs isolation", () => {
    it("stores role refs per session in per-tab mode", () => {
      const manager = new BrowserManager({ mode: "per-tab-per-session" });
      manager.setRoleRefs({ e1: { role: "button", name: "A" } } as any, "session-1");
      manager.setRoleRefs({ e2: { role: "textbox", name: "B" } } as any, "session-2");

      expect(Object.keys(manager.getRoleRefs("session-1"))).toEqual(["e1"]);
      expect(Object.keys(manager.getRoleRefs("session-2"))).toEqual(["e2"]);
    });
  });

  describe("context manager", () => {
    beforeEach(() => {
      const activeSessions = getActiveSessions();
      activeSessions.forEach((sessionId) => {
        releaseBrowserManager(sessionId).catch(() => {});
      });
    });

    it("should create new manager for new session", () => {
      const config: BrowserConfig = { mode: "per-tab-per-session" };
      const manager = getBrowserManager("test-session-4", config);

      expect(manager).toBeInstanceOf(BrowserManager);
      expect(manager.getSessionKey()).toBe("test-session-4");
    });

    it("should return same manager instance for same session", () => {
      const config: BrowserConfig = { mode: "per-tab-per-session" };
      const manager1 = getBrowserManager("test-session-5", config);
      const manager2 = getBrowserManager("test-session-5", config);

      expect(manager1).toBe(manager2);
    });

    it("should track active sessions", () => {
      getBrowserManager("session-a", { mode: "per-tab-per-session" });
      getBrowserManager("session-b", { mode: "per-tab-per-session" });

      const activeSessions = getActiveSessions();
      expect(activeSessions).toContain("session-a");
      expect(activeSessions).toContain("session-b");
    });

    it("should return correct browser stats", () => {
      getBrowserManager("stats-session-1", { mode: "per-tab-per-session" });
      getBrowserManager("stats-session-2", { mode: "per-tab-per-session" });

      const stats = getBrowserStats();
      expect(stats.totalSessions).toBe(2);
      expect(stats.activeSessions).toContain("stats-session-1");
      expect(stats.activeSessions).toContain("stats-session-2");
    });
  });

  describe("mode-specific behavior", () => {
    it("per-tab-per-session mode should isolate pages by session", () => {
      const manager1 = new BrowserManager({ mode: "per-tab-per-session" });
      manager1.setSessionKey("isolated-1");

      const manager2 = new BrowserManager({ mode: "per-tab-per-session" });
      manager2.setSessionKey("isolated-2");

      expect(manager1.getSessionKey()).toBe("isolated-1");
      expect(manager2.getSessionKey()).toBe("isolated-2");
    });

    it("should initialize with correct default config", () => {
      const manager = new BrowserManager({});

      expect(manager.isLaunched()).toBe(false);
      expect(manager.getPage()).toBeNull();
    });

    it("shared mode launch should reuse last open page", async () => {
      const manager = new BrowserManager({ mode: "shared" });
      const existing = makeFakePage();
      const newPage = makeFakePage();
      const context = makeFakeContext(newPage, [existing]);

      (manager as unknown as { context: BrowserContext | null }).context = context;
      const createdSpy = vi.spyOn(context, "newPage");

      const page = await manager.launch();

      expect(page).toBe(existing);
      expect(createdSpy).not.toHaveBeenCalled();
    });

    it("launch should set a clean fallback userAgent for persistent context", async () => {
      const manager = new BrowserManager({});
      const probePage = {
        evaluate: vi
          .fn()
          .mockResolvedValue("Mozilla/5.0 HeadlessChrome/145.0.0.0 Safari/537.36"),
      } as unknown as Page;
      const launchedPage = makeFakePage();

      const probeContext = {
        pages: () => [probePage],
        newPage: vi.fn().mockResolvedValue(probePage),
        close: vi.fn().mockResolvedValue(undefined),
      } as unknown as BrowserContext;
      const launchedContext = {
        pages: () => [launchedPage],
        newPage: vi.fn().mockResolvedValue(launchedPage),
        close: vi.fn().mockResolvedValue(undefined),
        addInitScript: vi.fn().mockResolvedValue(undefined),
      } as unknown as BrowserContext;

      const launchSpy = vi
        .spyOn(chromium, "launchPersistentContext")
        .mockResolvedValueOnce(probeContext)
        .mockResolvedValueOnce(launchedContext);

      const page = await manager.launch();

      expect(page).toBe(launchedPage);
      expect(launchSpy).toHaveBeenCalledTimes(2);
      const launchOptions = launchSpy.mock.calls[1]?.[1];
      expect(launchOptions?.userAgent).toContain("Chrome/");
      expect(launchOptions?.userAgent).not.toContain("HeadlessChrome");

      await manager.close();
      launchSpy.mockRestore();
    });

    it("close should remove temp profile directory", async () => {
      const manager = new BrowserManager({});
      const tempProfileDir = mkdtempSync(join(tmpdir(), "verybot-browser-test-"));
      (manager as unknown as { tempProfileDir: string | null }).tempProfileDir = tempProfileDir;

      expect(existsSync(tempProfileDir)).toBe(true);
      await manager.close();
      expect(existsSync(tempProfileDir)).toBe(false);
    });
  });
});

describe("BrowserManager - Type Safety", () => {
  it("should enforce correct browser mode types", () => {
    const manager1 = new BrowserManager({ mode: "per-tab-per-session" });
    expect(manager1).toBeDefined();

    const manager2 = new BrowserManager({ mode: "per-browser-per-session" });
    expect(manager2).toBeDefined();

    const manager3 = new BrowserManager({ mode: "shared" });
    expect(manager3).toBeDefined();
  });
});
