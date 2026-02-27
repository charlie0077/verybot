import { describe, expect, it, vi } from "vitest";
import { chatMethods } from "./chat.js";

function createAgentMock() {
  return {
    handleGatewayMessage: vi.fn(async () => "reply"),
    getSession: vi.fn(() => undefined),
    abortSession: vi.fn(() => false),
    getTeams: vi.fn(() => []),
    learnMemory: vi.fn(async () => ({
      topic: "concise",
      extracted: 2,
      saved: 1,
      skipped: 1,
      savedFacts: ["User prefers concise answers"],
    })),
    rememberMemory: vi.fn(async () => ({ saved: true, fact: "User prefers concise answers" })),
  };
}

describe("chatMethods", () => {
  it("chat.learn delegates to agent.learnMemory", async () => {
    const agent = createAgentMock();
    const methods = chatMethods(() => agent as any);

    const result = await methods["chat.learn"]({
      sessionKey: "default:gateway:session-1",
      topic: "concise",
    });

    expect(agent.learnMemory).toHaveBeenCalledWith(
      "default:gateway:session-1",
      "concise",
    );
    expect(result).toEqual({
      topic: "concise",
      extracted: 2,
      saved: 1,
      skipped: 1,
      savedFacts: ["User prefers concise answers"],
    });
  });

  it("chat.learn validates sessionKey", async () => {
    const methods = chatMethods(() => createAgentMock() as any);
    await expect(methods["chat.learn"]({ topic: "hello" } as any)).rejects.toThrow(
      "sessionKey is required and must be a string",
    );
  });

  it("chat.learn validates topic type", async () => {
    const methods = chatMethods(() => createAgentMock() as any);
    await expect(methods["chat.learn"]({ sessionKey: "default:gateway:s1", topic: 1 as any })).rejects.toThrow(
      "topic must be a string",
    );
  });

  it("chat.remember delegates to agent.rememberMemory", async () => {
    const agent = createAgentMock();
    const methods = chatMethods(() => agent as any);

    const result = await methods["chat.remember"]({
      sessionKey: "default:gateway:session-1",
      fact: "User prefers concise answers",
    });

    expect(agent.rememberMemory).toHaveBeenCalledWith(
      "default:gateway:session-1",
      "User prefers concise answers",
    );
    expect(result).toEqual({ saved: true, fact: "User prefers concise answers" });
  });
});
