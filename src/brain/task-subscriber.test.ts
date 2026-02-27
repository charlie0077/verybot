import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolSet } from "ai";
import type { Task } from "../tasks/types.js";
import type { SubscriberDeps } from "./task-subscriber.js";
import { TaskSubscriberManager } from "./task-subscriber.js";
import { adaptTools } from "./mcp-adapter.js";
import { runLoop } from "./loop.js";
import { getModel } from "./providers.js";
import { resolveInlineAttachmentContent } from "../tasks/inline-attachment-content.js";

vi.mock("./mcp-adapter.js", () => ({
  adaptTools: vi.fn(),
}));

vi.mock("./loop.js", () => ({
  runLoop: vi.fn(),
}));

vi.mock("./providers.js", () => ({
  getModel: vi.fn(),
}));

vi.mock("../tasks/inline-attachment-content.js", () => ({
  resolveInlineAttachmentContent: vi.fn(),
}));

describe("TaskSubscriberManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getModel).mockReturnValue({} as Parameters<typeof runLoop>[0]["model"]);
    vi.mocked(adaptTools).mockResolvedValue({
      model: {} as Parameters<typeof runLoop>[0]["model"],
      tools: {} as ToolSet,
    });
    vi.mocked(runLoop).mockResolvedValue({
      text: "done",
      responseMessages: [],
      assistantContent: null,
    });
    vi.mocked(resolveInlineAttachmentContent).mockResolvedValue({
      normalizedText: "Remove status\n\n[image attached]",
      imageDataUrls: ["data:image/png;base64,YWJj"],
    });
  });

  it("passes resolved inline attachments as image content for subscribed worker runs", async () => {
    const now = Date.now();
    const claimedTask: Task = {
      id: "25",
      teamId: "team-1",
      title: "Remove status",
      description: "![image](attachment://shot.png)",
      status: "new_status_2",
      assignee: null,
      priority: "medium",
      position: 0,
      attachments: [],
      needsHumanReview: false,
      claimedBy: "worker-1",
      claimedAt: now,
      updatedBy: "user",
      createdAt: now,
      updatedAt: now,
    };

    const deps: SubscriberDeps = {
      taskStore: {
        getById: vi.fn(() => claimedTask),
        finalizeClaimedTaskRun: vi.fn(() => true),
        cleanupStaleClaims: vi.fn(() => 0),
        claimTaskById: vi.fn(() => null),
      } as unknown as SubscriberDeps["taskStore"],
      teamStore: {
        getTeamById: vi.fn(() => ({
          id: "team-1",
          name: "PM",
          color: "#000000",
          workspace: "",
          variables: {},
          statuses: undefined,
          createdAt: now,
          updatedAt: now,
        })),
        getRuntimeAgentById: vi.fn(() => ({
          id: "worker-1",
          teamId: "team-1",
          name: "Planner",
          role: "worker",
          model: "openai:gpt-5",
          contextWindow: 0,
          maxSteps: 0,
          identity: "You are planner",
          tools: [],
          timeout: 60,
          templateId: null,
          subscriptions: ["new_status_2"],
          concurrency: 1,
          createdAt: now,
          updatedAt: now,
        })),
        getAgentById: vi.fn(() => null),
        findClaimableTasks: vi.fn(() => []),
      } as unknown as SubscriberDeps["teamStore"],
      sessionStore: {
        save: vi.fn(async () => undefined),
        updateMetadata: vi.fn(),
      } as unknown as SubscriberDeps["sessionStore"],
      memoryStore: null,
      embeddingProvider: null,
      memoryMaxResults: 5,
      config: {
        model: {
          provider: "openai",
          id: "gpt-5",
          contextWindow: 0,
          codexReasoningEffort: "medium",
        },
      } as SubscriberDeps["config"],
      baseTools: {},
      skillManager: { systemPrompt: "", readTool: null } as SubscriberDeps["skillManager"],
      browserConfig: null,
      sandboxEnabled: false,
    };

    const manager = new TaskSubscriberManager(deps);
    await (manager as unknown as { runWorker: (claim: unknown) => Promise<void> }).runWorker({
      agentId: "worker-1",
      teamId: "team-1",
      agentName: "Planner",
      model: "openai:gpt-5",
      task: claimedTask,
    });

    const runLoopCall = vi.mocked(runLoop).mock.calls[0]?.[0];
    expect(runLoopCall).toBeDefined();
    const firstMessage = runLoopCall?.messages[0];
    expect(firstMessage?.role).toBe("user");
    expect(firstMessage?.content).toEqual([
      { type: "image", image: "YWJj", mediaType: "image/png" },
      { type: "text", text: "Remove status\n\n[image attached]" },
    ]);
  });

  it("claims only one task per worker in a single poll tick when concurrency is 1", () => {
    const now = Date.now();
    const teamId = "team-1";
    const agentId = "worker-1";
    const taskIdOne = "task-1";
    const taskIdTwo = "task-2";
    const unresolvedAttachmentResolution = new Promise<{
      normalizedText: string;
      imageDataUrls: string[];
    }>(() => undefined);
    vi.mocked(resolveInlineAttachmentContent).mockImplementation(() => unresolvedAttachmentResolution);

    const claimableTasks = new Map<string, Task>([
      [
        taskIdOne,
        {
          id: taskIdOne,
          teamId,
          title: "First task",
          description: null,
          status: "new_status_2",
          assignee: null,
          priority: "medium",
          position: 0,
          attachments: [],
          needsHumanReview: false,
          claimedBy: null,
          claimedAt: null,
          updatedBy: "user",
          createdAt: now,
          updatedAt: now,
        },
      ],
      [
        taskIdTwo,
        {
          id: taskIdTwo,
          teamId,
          title: "Second task",
          description: null,
          status: "new_status_2",
          assignee: null,
          priority: "medium",
          position: 1,
          attachments: [],
          needsHumanReview: false,
          claimedBy: null,
          claimedAt: null,
          updatedBy: "user",
          createdAt: now,
          updatedAt: now,
        },
      ],
    ]);

    const claimTaskById = vi.fn((taskId: string, claimedBy: string) => {
      const task = claimableTasks.get(taskId);
      if (!task) return null;
      claimableTasks.delete(taskId);
      return {
        ...task,
        claimedBy,
        claimedAt: now,
        updatedAt: now,
      };
    });

    const deps: SubscriberDeps = {
      taskStore: {
        getById: vi.fn((taskId: string) => claimableTasks.get(taskId) ?? null),
        finalizeClaimedTaskRun: vi.fn(() => true),
        cleanupStaleClaims: vi.fn(() => 0),
        claimTaskById,
      } as unknown as SubscriberDeps["taskStore"],
      teamStore: {
        getTeamById: vi.fn(() => ({
          id: teamId,
          name: "PM",
          color: "#000000",
          workspace: "",
          variables: {},
          statuses: undefined,
          createdAt: now,
          updatedAt: now,
        })),
        getRuntimeAgentById: vi.fn(() => ({
          id: agentId,
          teamId,
          name: "Planner",
          role: "worker",
          model: "openai:gpt-5",
          contextWindow: 0,
          maxSteps: 0,
          identity: "You are planner",
          tools: [],
          timeout: 60,
          templateId: null,
          subscriptions: ["new_status_2"],
          concurrency: 1,
          createdAt: now,
          updatedAt: now,
        })),
        getAgentById: vi.fn(() => ({
          id: agentId,
          teamId,
          name: "Planner",
          role: "worker",
          model: "openai:gpt-5",
          contextWindow: 0,
          maxSteps: 0,
          identity: "You are planner",
          tools: [],
          timeout: 60,
          templateId: null,
          subscriptions: ["new_status_2"],
          concurrency: 1,
          createdAt: now,
          updatedAt: now,
        })),
        findClaimableTasks: vi.fn(() =>
          Array.from(claimableTasks.keys()).map((taskId) => ({
            taskId,
            teamId,
            agentId,
            agentName: "Planner",
            model: "openai:gpt-5",
          })),
        ),
      } as unknown as SubscriberDeps["teamStore"],
      sessionStore: {
        save: vi.fn(async () => undefined),
        updateMetadata: vi.fn(),
      } as unknown as SubscriberDeps["sessionStore"],
      memoryStore: null,
      embeddingProvider: null,
      memoryMaxResults: 5,
      config: {
        model: {
          provider: "openai",
          id: "gpt-5",
          contextWindow: 0,
          codexReasoningEffort: "medium",
        },
      } as SubscriberDeps["config"],
      baseTools: {},
      skillManager: { systemPrompt: "", readTool: null } as SubscriberDeps["skillManager"],
      browserConfig: null,
      sandboxEnabled: false,
    };

    const manager = new TaskSubscriberManager(deps);
    (manager as unknown as { poll: () => void }).poll();

    expect(claimTaskById).toHaveBeenCalledTimes(1);
    expect(claimTaskById).toHaveBeenCalledWith(taskIdOne, agentId);
  });
});
