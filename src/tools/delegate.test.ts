import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolSet } from "ai";
import type { AgentRegistry } from "../brain/agent-registry.js";
import type { ChannelStore } from "../brain/channel-store.js";
import type { DelegationStore } from "../brain/delegation-store.js";
import type { SessionStore } from "../brain/session-store.js";
import { createDelegationTools } from "./delegate.js";
import { adaptTools } from "../brain/mcp-adapter.js";
import { runLoop } from "../brain/loop.js";
import { resolveInlineAttachmentContent } from "../tasks/inline-attachment-content.js";

vi.mock("../brain/mcp-adapter.js", () => ({
  adaptTools: vi.fn(),
}));

vi.mock("../brain/loop.js", () => ({
  runLoop: vi.fn(),
}));

vi.mock("../tasks/inline-attachment-content.js", () => ({
  resolveInlineAttachmentContent: vi.fn(),
}));

type DelegateTool = {
  execute: (input: { worker: string; task: string; contextChannels?: string[] }) => Promise<string>;
};

type ListWorkersTool = {
  execute: (input: Record<string, never>) => Promise<string>;
};

type WorkerGetTool = {
  execute: (input: { worker: string }) => Promise<string>;
};

describe("createDelegationTools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveInlineAttachmentContent).mockImplementation(async (text: string) => ({
      normalizedText: text,
      imageDataUrls: [],
    }));
    vi.mocked(adaptTools).mockResolvedValue({
      model: {} as Parameters<typeof runLoop>[0]["model"],
      tools: {} as ToolSet,
    });
    vi.mocked(runLoop).mockResolvedValue({
      text: "done",
      responseMessages: [],
      assistantContent: null,
    });
  });

  it("forwards parsed codex reasoning effort to adapted delegated workers", async () => {
    const workerModel = {} as Parameters<typeof runLoop>[0]["model"];
    const registry = {
      delegatableWorkers: () => ["Coder"],
      getOrchestrator: () => ({ name: "Orchestrator" }),
      buildIdToNameMap: () => new Map<string, string>(),
      resolveWorker: () => ({
        agentConfig: {
          id: "worker-1",
          name: "Coder",
          model: "codex-cli:gpt-5.3-codex?reasoningEffort=xhigh",
          identity: "You are a coder",
          tools: [],
          maxSteps: 0,
          timeout: 60,
          contextWindow: 0,
        },
        model: workerModel,
        modelDef: { provider: "codex-cli", modelId: "gpt-5.3-codex", group: "Codex CLI", contextWindow: 200_000 },
        tools: {},
      }),
    } as unknown as AgentRegistry;

    const channelStore = {
      createChannel: () => "channel-1",
      post: () => 1,
      read: () => [],
    } as unknown as ChannelStore;

    const delegationStore = {
      insert: vi.fn(),
      markCompleted: vi.fn(),
      markFailed: vi.fn(),
    } as unknown as DelegationStore;

    const sessionStore = {
      save: vi.fn(async () => undefined),
      updateMetadata: vi.fn(),
    } as unknown as SessionStore;

    const tools = createDelegationTools(
      registry,
      channelStore,
      delegationStore,
      sessionStore,
      "orch-1",
      "session-1",
      null,
      null,
      5,
      vi.fn(),
      null,
    );

    const delegate = tools.delegate as unknown as DelegateTool;
    const message = await delegate.execute({ worker: "Coder", task: "Fix bug" });
    expect(message).toContain("Delegated to Coder");

    // Delegated worker runs in background; let pending microtasks settle.
    await Promise.resolve();
    await Promise.resolve();

    expect(adaptTools).toHaveBeenCalledWith(
      "codex-cli",
      "gpt-5.3-codex",
      workerModel,
      expect.any(Object),
      expect.objectContaining({
        sandboxEnabled: false,
        codexReasoningEffort: "xhigh",
      }),
    );
  });

  it("passes resolved inline attachments as image content for delegated workers", async () => {
    const workerModel = {} as Parameters<typeof runLoop>[0]["model"];
    const registry = {
      delegatableWorkers: () => ["Coder"],
      getOrchestrator: () => ({ name: "Orchestrator" }),
      buildIdToNameMap: () => new Map<string, string>(),
      resolveWorker: () => ({
        agentConfig: {
          id: "worker-1",
          name: "Coder",
          model: "codex-cli:gpt-5.3-codex",
          identity: "You are a coder",
          tools: [],
          maxSteps: 0,
          timeout: 60,
          contextWindow: 0,
        },
        model: workerModel,
        modelDef: { provider: "codex-cli", modelId: "gpt-5.3-codex", group: "Codex CLI", contextWindow: 200_000 },
        tools: {},
      }),
    } as unknown as AgentRegistry;

    const channelStore = {
      createChannel: () => "channel-1",
      post: () => 1,
      read: () => [],
    } as unknown as ChannelStore;

    const delegationStore = {
      insert: vi.fn(),
      markCompleted: vi.fn(),
      markFailed: vi.fn(),
    } as unknown as DelegationStore;

    const sessionStore = {
      save: vi.fn(async () => undefined),
      updateMetadata: vi.fn(),
    } as unknown as SessionStore;

    vi.mocked(resolveInlineAttachmentContent).mockResolvedValue({
      normalizedText: "Fix status [image attached]",
      imageDataUrls: ["data:image/png;base64,YWJj"],
    });

    const tools = createDelegationTools(
      registry,
      channelStore,
      delegationStore,
      sessionStore,
      "orch-1",
      "session-1",
      null,
      null,
      5,
      vi.fn(),
      null,
    );

    const delegate = tools.delegate as unknown as DelegateTool;
    const message = await delegate.execute({ worker: "Coder", task: "Fix status ![img](attachment://shot.png)" });
    expect(message).toContain("Delegated to Coder");

    // Delegated worker runs in background; let pending microtasks settle.
    await Promise.resolve();
    await Promise.resolve();

    const runLoopCall = vi.mocked(runLoop).mock.calls.at(-1)?.[0];
    expect(runLoopCall).toBeDefined();
    const firstMessage = runLoopCall?.messages[0];
    expect(firstMessage?.role).toBe("user");
    expect(firstMessage?.content).toEqual([
      { type: "image", image: "YWJj", mediaType: "image/png" },
      { type: "text", text: "Fix status [image attached]" },
    ]);
  });

  it("lists workers on demand using names only", async () => {
    const registry = {
      delegatableWorkers: () => ["Coder", "Reviewer"],
      buildIdToNameMap: () => new Map<string, string>(),
      resolveWorker: () => null,
    } as unknown as AgentRegistry;

    const channelStore = {
      createChannel: () => "channel-1",
      post: () => 1,
      read: () => [],
    } as unknown as ChannelStore;

    const delegationStore = {
      insert: vi.fn(),
      markCompleted: vi.fn(),
      markFailed: vi.fn(),
    } as unknown as DelegationStore;

    const sessionStore = {
      save: vi.fn(async () => undefined),
      updateMetadata: vi.fn(),
    } as unknown as SessionStore;

    const tools = createDelegationTools(
      registry,
      channelStore,
      delegationStore,
      sessionStore,
      "orch-1",
      "session-1",
      null,
      null,
      5,
      vi.fn(),
      null,
    );

    const listWorkers = tools.list_workers as unknown as ListWorkersTool;
    const output = await listWorkers.execute({});

    expect(output).toContain("Available workers:");
    expect(output).toContain("- Coder");
    expect(output).toContain("- Reviewer");
  });

  it("instructs caller to use list_workers when worker is unknown", async () => {
    const registry = {
      delegatableWorkers: () => ["Coder"],
      buildIdToNameMap: () => new Map<string, string>(),
      resolveWorker: () => null,
    } as unknown as AgentRegistry;

    const channelStore = {
      createChannel: () => "channel-1",
      post: () => 1,
      read: () => [],
    } as unknown as ChannelStore;

    const delegationStore = {
      insert: vi.fn(),
      markCompleted: vi.fn(),
      markFailed: vi.fn(),
    } as unknown as DelegationStore;

    const sessionStore = {
      save: vi.fn(async () => undefined),
      updateMetadata: vi.fn(),
    } as unknown as SessionStore;

    const tools = createDelegationTools(
      registry,
      channelStore,
      delegationStore,
      sessionStore,
      "orch-1",
      "session-1",
      null,
      null,
      5,
      vi.fn(),
      null,
    );

    const delegate = tools.delegate as unknown as DelegateTool;
    const message = await delegate.execute({ worker: "Nonexistent", task: "Do thing" });
    expect(message).toBe("Unknown worker: Nonexistent. Call list_workers to see available workers.");
  });

  it("returns full worker details on demand with worker_get", async () => {
    const registry = {
      delegatableWorkers: () => ["Coder"],
      buildIdToNameMap: () => new Map<string, string>(),
      resolveWorker: () => null,
      getWorker: () => ({
        id: "worker-1",
        name: "Coder",
        model: "openai:gpt-5",
        contextWindow: 0,
        maxSteps: 20,
        identity: "You are a coding specialist.",
        tools: ["bash", "read", "edit"],
        timeout: 1800,
        templateId: "tpl-coder",
        subscriptions: ["todo", "in_progress"],
        concurrency: 2,
      }),
    } as unknown as AgentRegistry;

    const channelStore = {
      createChannel: () => "channel-1",
      post: () => 1,
      read: () => [],
    } as unknown as ChannelStore;

    const delegationStore = {
      insert: vi.fn(),
      markCompleted: vi.fn(),
      markFailed: vi.fn(),
    } as unknown as DelegationStore;

    const sessionStore = {
      save: vi.fn(async () => undefined),
      updateMetadata: vi.fn(),
    } as unknown as SessionStore;

    const tools = createDelegationTools(
      registry,
      channelStore,
      delegationStore,
      sessionStore,
      "orch-1",
      "session-1",
      null,
      null,
      5,
      vi.fn(),
      null,
    );

    const workerGet = tools.worker_get as unknown as WorkerGetTool;
    const output = await workerGet.execute({ worker: "Coder" });

    expect(output).toContain("Worker: Coder");
    expect(output).toContain("- model: openai:gpt-5");
    expect(output).toContain("- tools: bash, read, edit");
    expect(output).toContain("- identity:");
    expect(output).toContain("You are a coding specialist.");
  });

  it("worker_get points to list_workers when name is unknown", async () => {
    const registry = {
      delegatableWorkers: () => ["Coder"],
      buildIdToNameMap: () => new Map<string, string>(),
      resolveWorker: () => null,
      getWorker: () => undefined,
    } as unknown as AgentRegistry;

    const channelStore = {
      createChannel: () => "channel-1",
      post: () => 1,
      read: () => [],
    } as unknown as ChannelStore;

    const delegationStore = {
      insert: vi.fn(),
      markCompleted: vi.fn(),
      markFailed: vi.fn(),
    } as unknown as DelegationStore;

    const sessionStore = {
      save: vi.fn(async () => undefined),
      updateMetadata: vi.fn(),
    } as unknown as SessionStore;

    const tools = createDelegationTools(
      registry,
      channelStore,
      delegationStore,
      sessionStore,
      "orch-1",
      "session-1",
      null,
      null,
      5,
      vi.fn(),
      null,
    );

    const workerGet = tools.worker_get as unknown as WorkerGetTool;
    const output = await workerGet.execute({ worker: "Nonexistent" });
    expect(output).toBe("Unknown worker: Nonexistent. Call list_workers to see available workers.");
  });
});
