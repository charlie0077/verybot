import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config.js";
import type { ConfigStore } from "../config/store.js";
import { IntegrationRegistry } from "./registry.js";
import { createMcpIntegration } from "./mcp.js";
import { scanUserIntegrations } from "./scanner.js";

const mocks = vi.hoisted(() => ({
  created: [] as Array<{
    name: string;
    initialize: ReturnType<typeof vi.fn>;
    cleanup: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("./scanner.js", () => ({
  scanUserIntegrations: vi.fn(async () => []),
}));

vi.mock("./mcp.js", () => ({
  createMcpIntegration: vi.fn(async (name: string) => {
    const initialize = vi.fn(async () => undefined);
    const cleanup = vi.fn(async () => undefined);
    mocks.created.push({ name, initialize, cleanup });
    return {
      id: `mcp:${name}`,
      name,
      source: "mcp" as const,
      tools: {
        tools: {},
        initialize,
        cleanup,
      },
    };
  }),
}));

function makeConfig(mcpServers: Config["mcpServers"]): Config {
  return {
    gateway: { port: 28789, token: "test-token" },
    model: {
      provider: "openai",
      id: "gpt-5",
      maxSteps: 20,
      contextWindow: 0,
    },
    browserHeadless: true,
    browserUserAgent: "",
    browserMode: "per-tab-per-session",
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
    mcpServers,
    tts: { enabled: false, voice: "en-US-AriaNeural", replyMode: "text" },
  };
}

function fakeStore(): ConfigStore {
  return {
    load: () => ({}),
  } as unknown as ConfigStore;
}

describe("IntegrationRegistry MCP refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.created.length = 0;
    vi.mocked(scanUserIntegrations).mockResolvedValue([]);
  });

  it("keeps existing MCP connection on unchanged server config", async () => {
    const registry = new IntegrationRegistry();
    const store = fakeStore();
    const config = makeConfig({
      fs: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"] },
    });

    await registry.refresh(store, "/tmp", config);
    expect(createMcpIntegration).toHaveBeenCalledTimes(1);
    const firstCleanup = mocks.created[0].cleanup;

    await registry.refresh(store, "/tmp", config);

    expect(createMcpIntegration).toHaveBeenCalledTimes(1);
    expect(firstCleanup).not.toHaveBeenCalled();
    expect(registry.has("fs")).toBe(true);
  });

  it("reconnects MCP server when config changes", async () => {
    const registry = new IntegrationRegistry();
    const store = fakeStore();

    await registry.refresh(store, "/tmp", makeConfig({
      fs: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"] },
    }));
    const firstCleanup = mocks.created[0].cleanup;

    await registry.refresh(store, "/tmp", makeConfig({
      fs: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
    }));

    expect(createMcpIntegration).toHaveBeenCalledTimes(2);
    expect(firstCleanup).toHaveBeenCalledTimes(1);
    expect(registry.has("fs")).toBe(true);
  });

  it("disconnects MCP server when removed from config", async () => {
    const registry = new IntegrationRegistry();
    const store = fakeStore();

    await registry.refresh(store, "/tmp", makeConfig({
      fs: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"] },
    }));
    const firstCleanup = mocks.created[0].cleanup;

    await registry.refresh(store, "/tmp", makeConfig({}));

    expect(firstCleanup).toHaveBeenCalledTimes(1);
    expect(registry.has("fs")).toBe(false);
  });
});
