import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config.js";
import type { BrowserManager } from "../computer/browser/manager.js";
import { buildRunTools, type RunToolsDeps } from "./run-tools.js";

const mocks = vi.hoisted(() => ({
  createBrowserTools: vi.fn(),
  createDelegationTools: vi.fn(),
  createBashTool: vi.fn(),
}));

vi.mock("../computer/browser/tools.js", () => ({
  createBrowserTools: mocks.createBrowserTools,
}));

vi.mock("../tools/delegate.js", () => ({
  createDelegationTools: mocks.createDelegationTools,
}));

vi.mock("../tools/bash.js", () => ({
  createBashTool: mocks.createBashTool,
}));

function makeConfig(
  mode: Config["browserMode"],
  overrides?: Partial<Pick<Config, "browserHeadless" | "browserUserAgent" | "browserModeOptions">>,
): Config {
  return {
    gateway: { port: 28789, token: "test-token" },
    model: {
      provider: "anthropic",
      id: "claude-sonnet-4-5-20250929",
      maxSteps: 10,
      contextWindow: 0,
    },
    browserHeadless: overrides?.browserHeadless ?? true,
    browserUserAgent: overrides?.browserUserAgent ?? "",
    browserMode: mode,
    browserModeOptions: overrides?.browserModeOptions ?? {},
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

function makeDeps(
  config: Config,
  browserManager: BrowserManager | null,
  withDelegation = false,
): RunToolsDeps {
  return {
    baseTools: {},
    config,
    memoryStore: null,
    embeddingProvider: null,
    memoryMaxResults: 5,
    sandbox: null,
    skillManager: { systemPrompt: "", readTool: null } as unknown as RunToolsDeps["skillManager"],
    integrationRegistry: {
      names: [],
      getToolsFor: () => ({}),
    } as unknown as RunToolsDeps["integrationRegistry"],
    scheduleStore: null,
    taskStore: null,
    teamStore: null,
    promptTemplateStore: null,
    desktopAdapter: null,
    browserManager,
    effectiveModel: "anthropic:claude-sonnet-4-5-20250929",
    agentRegistry: withDelegation
      ? ({ delegatableWorkers: () => ["worker-1"] } as unknown as RunToolsDeps["agentRegistry"])
      : null,
    delegationStore: withDelegation ? ({} as RunToolsDeps["delegationStore"]) : null,
    channelStore: withDelegation ? ({} as RunToolsDeps["channelStore"]) : null,
    channelManager: null,
    sessionStore: {} as RunToolsDeps["sessionStore"],
    modelId: "claude-sonnet-4-5-20250929",
    onWorkerComplete: () => {},
  };
}

describe("buildRunTools browser mode wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createBrowserTools.mockReturnValue({});
    mocks.createDelegationTools.mockReturnValue({});
    mocks.createBashTool.mockReturnValue(null);
  });

  it("binds browser tools with session key in per-tab-per-session mode", () => {
    const browser = {} as BrowserManager;
    const sessionKey = "team1:gateway:abc";
    const deps = makeDeps(makeConfig("per-tab-per-session"), browser);

    buildRunTools(deps, sessionKey, new Set(), undefined, undefined, undefined, undefined, undefined, sessionKey);

    expect(mocks.createBrowserTools).toHaveBeenCalledTimes(1);
    expect(mocks.createBrowserTools).toHaveBeenCalledWith(browser, sessionKey);
  });

  it("does not bind browser tools with session key in per-browser-per-session mode", () => {
    const browser = {} as BrowserManager;
    const sessionKey = "team1:gateway:def";
    const deps = makeDeps(makeConfig("per-browser-per-session"), browser);

    buildRunTools(deps, sessionKey, new Set(), undefined, undefined, undefined, undefined, undefined, sessionKey);

    expect(mocks.createBrowserTools).toHaveBeenCalledTimes(1);
    expect(mocks.createBrowserTools).toHaveBeenCalledWith(browser, undefined);
  });

  it("forwards browser mode config to delegation tools", () => {
    const browser = {} as BrowserManager;
    const sessionKey = "team1:gateway:delegation";
    const deps = makeDeps(
      makeConfig("per-browser-per-session", {
        browserHeadless: false,
        browserUserAgent: "VerybotTestUA/1.0",
        browserModeOptions: { maxPagesPerSession: 3 },
      }),
      browser,
      true,
    );

    buildRunTools(
      deps,
      sessionKey,
      new Set(),
      undefined,
      "orchestrator-id",
      "orchestrator",
      "team1",
      "team1",
      "team1:gateway:delegation",
    );

    expect(mocks.createDelegationTools).toHaveBeenCalledTimes(1);
    const args = mocks.createDelegationTools.mock.calls[0];
    expect(args[10]).toEqual({
      headless: false,
      userAgent: "VerybotTestUA/1.0",
      mode: "per-browser-per-session",
      modeOptions: { maxPagesPerSession: 3 },
    });
  });

  it("passes team workspace to bash tool context", () => {
    const browser = {} as BrowserManager;
    const sessionKey = "team1:gateway:cwd";
    const deps = makeDeps(makeConfig("shared"), browser);
    const teamWorkspace = "/Users/zhenchaochen/work/temp/pm-tool";

    buildRunTools(
      deps,
      sessionKey,
      new Set(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      sessionKey,
      teamWorkspace,
    );

    expect(mocks.createBashTool).toHaveBeenCalledWith(
      deps.config.bash,
      expect.objectContaining({
        sessionKey,
        cwd: teamWorkspace,
      }),
    );
  });

  it("does not add delegation tools for worker-bound runs", () => {
    const browser = {} as BrowserManager;
    const sessionKey = "team1:gateway:worker-bound";
    const deps = makeDeps(makeConfig("per-browser-per-session"), browser, true);

    buildRunTools(
      deps,
      sessionKey,
      new Set(),
      undefined,
      "worker-id",
      "worker",
      "team1",
      "team1",
      "team1:gateway:worker-bound",
    );

    expect(mocks.createDelegationTools).not.toHaveBeenCalled();
  });

  it("does not add worker CRUD tools for worker-bound runs", () => {
    const sessionKey = "team1:gateway:worker-no-worker-crud";
    const deps = {
      ...makeDeps(makeConfig("shared"), null),
      teamStore: {} as RunToolsDeps["teamStore"],
    };

    const tools = buildRunTools(
      deps,
      sessionKey,
      new Set(),
      undefined,
      "worker-id",
      "worker",
      "team1",
      "team1",
      sessionKey,
    );

    expect(tools.worker_create).toBeUndefined();
    expect(tools.worker_update).toBeUndefined();
    expect(tools.worker_delete).toBeUndefined();
  });

  it("adds only team-scoped worker CRUD tools for non-default orchestrators", () => {
    const sessionKey = "team1:gateway:team-scoped-worker-crud";
    const deps = {
      ...makeDeps(makeConfig("shared"), null),
      teamStore: {} as RunToolsDeps["teamStore"],
    };

    const tools = buildRunTools(
      deps,
      sessionKey,
      new Set(),
      undefined,
      "orchestrator-id",
      "orchestrator",
      "team1",
      "team1",
      sessionKey,
    );

    expect(tools.worker_create).toBeDefined();
    expect(tools.worker_update).toBeDefined();
    expect(tools.worker_delete).toBeDefined();
    expect(tools.team_create).toBeUndefined();
    expect(tools.team_update).toBeUndefined();
    expect(tools.team_list).toBeUndefined();
    expect(tools.orchestrator_update).toBeUndefined();
  });

  it("enforces worker allowlist for dynamically injected tools", () => {
    const browser = {} as BrowserManager;
    const sessionKey = "team1:gateway:allowlist";
    const deps = makeDeps(makeConfig("per-browser-per-session"), browser);

    mocks.createBrowserTools.mockReturnValue({
      browser_navigate: { description: "navigate" } as any,
      browser_snapshot: { description: "snapshot" } as any,
    });
    mocks.createBashTool.mockReturnValue({ description: "bash" } as any);

    const tools = buildRunTools(
      deps,
      sessionKey,
      new Set(),
      undefined,
      "worker-id",
      "worker",
      "team1",
      "team1",
      "team1:gateway:allowlist",
      undefined,
      ["browser_navigate"],
    );

    expect(tools.browser_navigate).toBeDefined();
    expect(tools.browser_snapshot).toBeUndefined();
    expect(tools.bash).toBeUndefined();
  });
});
