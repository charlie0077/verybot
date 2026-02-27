import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Agent } from "./agent.js";
import type { Config } from "../config.js";
import { ConfigStore } from "../config/store.js";
import { TeamStore } from "../teams/store.js";
import { DEFAULT_TEAM_ID } from "../config/agent-config.js";
import { on } from "../events.js";
import type { Channel } from "../channels/types.js";

const TEST_GATEWAY_PORT = 28789;

function makeConfig(): Config {
  return {
    gateway: { port: TEST_GATEWAY_PORT, token: "test-token" },
    model: {
      provider: "anthropic",
      id: "claude-sonnet-4-5-20250929",
      maxSteps: 10,
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
    mcpServers: {},
    tts: { enabled: false, voice: "en-US-AriaNeural", replyMode: "text" },
  };
}

function makeUnconfiguredModelConfig(): Config {
  const config = makeConfig();
  config.model = {
    provider: "",
    id: "",
    maxSteps: 10,
    contextWindow: 0,
  };
  return config;
}

describe("Agent abort behavior", () => {
  it("returns setup guidance when global model is not configured", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "verybot-agent-model-required-test-"));
    const configStore = new ConfigStore(dataDir);
    const agent = new Agent({
      config: makeUnconfiguredModelConfig(),
      configStore,
      tools: {},
      dataDir,
    });
    const sessionKey = "default:gateway:model-required";
    const chatEvents: Array<{
      sessionKey: string;
      state: string;
      message?: { role: string; content: string };
    }> = [];
    const unsubscribe = on("chat", (payload) => {
      if (!payload || typeof payload !== "object") return;
      const candidate = payload as {
        sessionKey?: string;
        state?: string;
        message?: { role?: string; content?: string };
      };
      if (candidate.sessionKey !== sessionKey) return;
      chatEvents.push({
        sessionKey: candidate.sessionKey ?? "",
        state: candidate.state ?? "",
        message:
          candidate.message && typeof candidate.message.content === "string"
            ? {
                role: candidate.message.role ?? "",
                content: candidate.message.content,
              }
            : undefined,
      });
    });

    try {
      const reply = await agent.handleGatewayMessage(sessionKey, "hello");
      expect(reply).toContain("Model is not configured.");
      expect(reply).toContain("Settings -> Agent");
      expect(chatEvents).toContainEqual({
        sessionKey,
        state: "final",
        message: expect.objectContaining({
          role: "assistant",
          content: expect.stringContaining("Model is not configured."),
        }),
      });
    } finally {
      unsubscribe();
    }
  });

  it("sends setup guidance to channel users when global model is not configured", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "verybot-agent-channel-model-required-test-"));
    const configStore = new ConfigStore(dataDir);
    const agent = new Agent({
      config: makeUnconfiguredModelConfig(),
      configStore,
      tools: {},
      dataDir,
    });
    const channelSend = vi.fn(async () => undefined);
    const channel: Channel = {
      name: "test-channel",
      start: async () => undefined,
      stop: async () => undefined,
      send: channelSend,
    };

    await agent.handleMessage(
      {
        channelType: "telegram",
        channelId: "123",
        userId: "u1",
        teamId: "default",
        text: "hello",
      },
      channel,
    );

    expect(channelSend).toHaveBeenCalledWith(
      "123",
      expect.stringContaining("Model is not configured."),
    );
  });

  it("does not synthesize a default team when no team store is configured", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "verybot-agent-get-teams-no-store-test-"));
    const configStore = new ConfigStore(dataDir);
    const agent = new Agent({
      config: makeConfig(),
      configStore,
      tools: {},
      dataDir,
    });

    expect(agent.getTeams()).toEqual([]);
  });

  it("hides default team from getTeams and only returns managed teams", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "verybot-agent-get-teams-default-hidden-test-"));
    const configStore = new ConfigStore(dataDir);
    const teamStore = await TeamStore.create(join(dataDir, "memory.db"));
    teamStore.ensureTeamWhenEmpty();
    const ops = teamStore.createTeam({ name: "Ops" });
    teamStore.createAgent(ops.id, {
      name: "lead",
      role: "orchestrator",
      model: "anthropic:claude-sonnet-4-5-20250929",
      identity: "Ops lead",
    });

    const agent = new Agent({
      config: makeConfig(),
      configStore,
      tools: {},
      dataDir,
      teamStore,
    });

    const teams = agent.getTeams();
    expect(teams.map((t) => t.id)).toEqual([ops.id]);

    teamStore.close();
  });

  it("skips integration re-run when the run signal is aborted", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "verybot-agent-abort-test-"));
    const configStore = new ConfigStore(dataDir);
    configStore.save({
      model: "anthropic:claude-sonnet-4-5-20250929",
      gateway: { port: TEST_GATEWAY_PORT },
    });
    const agent = new Agent({
      config: makeConfig(),
      configStore,
      tools: {},
      dataDir,
    }) as unknown as {
      getOrCreateSession: (key: string) => Promise<{
        teamId?: string;
        channelType?: string;
        channelId?: string;
        integrations?: Set<string>;
      }>;
      main: (sessionKey: string, text: string, images?: string[], abortSignal?: AbortSignal) => Promise<string>;
      buildAdaptAndRun: (opts: { activeIntegrations: Set<string> }) => Promise<string>;
    };

    const sessionKey = "default:gateway:abort-skip-rerun";
    const state = await agent.getOrCreateSession(sessionKey);
    state.teamId = "default";
    state.channelType = "gateway";
    state.channelId = sessionKey;
    state.integrations = new Set(["base"]);

    const buildSpy = vi.spyOn(agent, "buildAdaptAndRun").mockImplementation(async (opts) => {
      opts.activeIntegrations.add("changed-during-run");
      return "";
    });

    const controller = new AbortController();
    controller.abort();

    await agent.main(sessionKey, "stop-now", undefined, controller.signal);
    expect(buildSpy).toHaveBeenCalledTimes(1);
  });

  it("stores parsed channel id for resumed non-gateway sessions", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "verybot-agent-channel-id-test-"));
    const configStore = new ConfigStore(dataDir);
    const agent = new Agent({
      config: makeConfig(),
      configStore,
      tools: {},
      dataDir,
    }) as unknown as {
      queue: { enqueue: (sessionKey: string, text: string, images?: string[]) => Promise<string> };
      getOrCreateSession: (key: string) => Promise<{
        teamId?: string;
        channelType?: string;
        channelId?: string;
      }>;
      handleGatewayMessage: (sessionKey: string, text: string, agentId?: string, images?: string[]) => Promise<string>;
    };

    const enqueue = vi.fn(async () => "ok");
    agent.queue = { enqueue };

    const sessionKey = "team-1:slack:C1234567890";
    await agent.handleGatewayMessage(sessionKey, "hello");
    const state = await agent.getOrCreateSession(sessionKey);

    expect(state.channelType).toBe("slack");
    expect(state.channelId).toBe("C1234567890");
    expect(enqueue).toHaveBeenCalledWith(sessionKey, "hello", undefined);
  });

  it("does not bootstrap teams during session creation", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "verybot-agent-team-bootstrap-test-"));
    const configStore = new ConfigStore(dataDir);
    const teamStore = await TeamStore.create(join(dataDir, "memory.db"));
    const agent = new Agent({
      config: makeConfig(),
      configStore,
      tools: {},
      dataDir,
      teamStore,
    }) as unknown as {
      getOrCreateSession: (key: string) => Promise<unknown>;
    };

    expect(teamStore.listTeams()).toHaveLength(0);
    await agent.getOrCreateSession("team-1:gateway:new-session");
    expect(teamStore.getTeamById(DEFAULT_TEAM_ID)).toBeNull();
    expect(teamStore.getTeamById("team-1")).toBeNull();

    teamStore.close();
  });
});
