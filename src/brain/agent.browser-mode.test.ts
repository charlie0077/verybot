import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { Agent } from "./agent.js";
import type { Config } from "../config.js";
import { ConfigStore } from "../config/store.js";
import { BrowserManager } from "../computer/browser/manager.js";

function makeConfig(browserMode: Config["browserMode"]): Config {
  return {
    gateway: { port: 28789, token: "test-token" },
    model: {
      provider: "anthropic",
      id: "claude-sonnet-4-5-20250929",
      maxSteps: 10,
      contextWindow: 0,
    },
    browserHeadless: true,
    browserUserAgent: "",
    browserMode,
    browserModeOptions: {},
    language: "en",
    identity: "test",
    bash: { security: "full", safeBins: [], allowlist: [] },
    sandbox: {
      enabled: false,
      image: "ubuntu:24.04",
      memoryLimit: "256m",
      pidsLimit: 64,
      idleTimeoutMs: 300_000,
    },
    desktop: { enabled: false },
    memory: { enabled: false, maxResults: 5 },
    channels: {},
    mcpServers: {},
    tts: { enabled: false, voice: "en-US-AriaNeural", replyMode: "text" },
  };
}

function makeAgent(browserMode: Config["browserMode"]): Agent {
  const dataDir = mkdtempSync(join(tmpdir(), "verybot-agent-test-"));
  const configStore = new ConfigStore(dataDir);
  const agent = new Agent({
    config: makeConfig(browserMode),
    configStore,
    tools: {},
    dataDir,
    browserManager: new BrowserManager({
      headless: true,
      mode: browserMode,
    }),
  });
  return agent;
}

describe("Agent browser mode lifecycle", () => {
  it("reuses per-session browser manager in per-browser-per-session mode", () => {
    const agent = makeAgent("per-browser-per-session") as unknown as {
      getRunBrowserManager: (sessionKey: string) => BrowserManager | null;
      browserManager: BrowserManager | null;
    };

    const base = agent.browserManager;
    const sessionA1 = agent.getRunBrowserManager("team1:gateway:a");
    const sessionA2 = agent.getRunBrowserManager("team1:gateway:a");
    const sessionB = agent.getRunBrowserManager("team1:gateway:b");

    expect(base).not.toBeNull();
    expect(sessionA1).not.toBe(base);
    expect(sessionA1).toBe(sessionA2);
    expect(sessionB).not.toBe(sessionA1);
  });

  it("uses shared manager in non per-browser mode", () => {
    const agent = makeAgent("per-tab-per-session") as unknown as {
      getRunBrowserManager: (sessionKey: string) => BrowserManager | null;
      browserManager: BrowserManager | null;
    };

    const base = agent.browserManager;
    const sessionMgr = agent.getRunBrowserManager("team1:gateway:a");
    expect(sessionMgr).toBe(base);
  });

  it("clearSession closes and removes per-session browser manager", async () => {
    const agent = makeAgent("per-browser-per-session") as unknown as {
      getRunBrowserManager: (sessionKey: string) => BrowserManager | null;
      clearSession: (sessionKey: string) => Promise<void>;
      sessionBrowserManagers: Map<string, BrowserManager>;
    };

    const sessionKey = "team1:gateway:a";
    const manager = agent.getRunBrowserManager(sessionKey);
    expect(manager).not.toBeNull();
    if (!manager) return;

    const closeSpy = vi.spyOn(manager, "close").mockResolvedValue(undefined);
    await agent.clearSession(sessionKey);

    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(agent.sessionBrowserManagers.has(sessionKey)).toBe(false);
  });

  it("forceConfigReload closes per-session managers when leaving per-browser mode", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "verybot-agent-test-"));
    const configStore = new ConfigStore(dataDir);
    const agent = new Agent({
      config: makeConfig("per-browser-per-session"),
      configStore,
      tools: {},
      dataDir,
      browserManager: new BrowserManager({
        headless: true,
        mode: "per-browser-per-session",
      }),
    }) as unknown as {
      getRunBrowserManager: (sessionKey: string) => BrowserManager | null;
      forceConfigReload: () => Promise<void>;
      sessionBrowserManagers: Map<string, BrowserManager>;
    };

    const sessionKey = "team1:gateway:reload";
    const manager = agent.getRunBrowserManager(sessionKey);
    expect(manager).not.toBeNull();
    if (!manager) return;

    const closeSpy = vi.spyOn(manager, "close").mockResolvedValue(undefined);
    configStore.save({
      model: "anthropic:claude-sonnet-4-5-20250929",
      browserMode: "shared",
      gateway: { port: 28789 },
    });

    await agent.forceConfigReload();

    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(agent.sessionBrowserManagers.size).toBe(0);
  });

  it("forceConfigReload closes shared browser when entering per-browser mode", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "verybot-agent-test-"));
    const configStore = new ConfigStore(dataDir);
    const sharedBrowser = new BrowserManager({
      headless: true,
      mode: "per-tab-per-session",
    });
    const closeSpy = vi.spyOn(sharedBrowser, "close").mockResolvedValue(undefined);
    const agent = new Agent({
      config: makeConfig("per-tab-per-session"),
      configStore,
      tools: {},
      dataDir,
      browserManager: sharedBrowser,
    });

    configStore.save({
      model: "anthropic:claude-sonnet-4-5-20250929",
      browserMode: "per-browser-per-session",
      gateway: { port: 28789 },
    });

    await agent.forceConfigReload();

    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("forceConfigReload updates existing per-session manager config in per-browser mode", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "verybot-agent-test-"));
    const configStore = new ConfigStore(dataDir);
    const agent = new Agent({
      config: makeConfig("per-browser-per-session"),
      configStore,
      tools: {},
      dataDir,
      browserManager: new BrowserManager({
        headless: true,
        mode: "per-browser-per-session",
      }),
    }) as unknown as {
      getRunBrowserManager: (sessionKey: string) => BrowserManager | null;
      forceConfigReload: () => Promise<void>;
    };

    const sessionKey = "team1:gateway:config-update";
    const manager = agent.getRunBrowserManager(sessionKey);
    expect(manager).not.toBeNull();
    if (!manager) return;

    configStore.save({
      model: "anthropic:claude-sonnet-4-5-20250929",
      browserMode: "per-browser-per-session",
      browserHeadless: false,
      browserUserAgent: "VerybotTestUA/2.0",
      browserModeOptions: { maxPagesPerSession: 2 },
      gateway: { port: 28789 },
    });

    await agent.forceConfigReload();

    const internal = manager as unknown as {
      config: {
        headless?: boolean;
        userAgent?: string;
        mode?: string;
        modeOptions?: Record<string, unknown>;
        profileDir?: string;
      };
    };
    expect(internal.config.headless).toBe(false);
    expect(internal.config.userAgent).toBe("VerybotTestUA/2.0");
    expect(internal.config.mode).toBe("shared");
    expect(internal.config.profileDir).toBe("temp");
    expect(internal.config.modeOptions).toEqual({ maxPagesPerSession: 2 });
  });
});
