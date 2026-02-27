import { describe, expect, it, vi } from "vitest";
import { CommandRouter, type CommandPart } from "./commands.js";

function render(parts: CommandPart[]): string {
  return parts
    .map((part) => {
      if (typeof part === "string") return part;
      if ("bold" in part) return part.bold;
      return part.code;
    })
    .join("");
}

describe("CommandRouter /learn", () => {
  it("handles /learn <topic> and passes the resolved team id", async () => {
    const onLearn = vi.fn(async (_channelType, _channelId, topic) => ({
      topic,
      extracted: 2,
      saved: 1,
      skipped: 1,
      savedFacts: ["User prefers concise answers"],
    }));
    const router = new CommandRouter({
      onLearn,
      defaultTeamId: "default",
      listTeams: () => [
        { id: "default", name: "Default" },
        { id: "team-a", name: "Team A" },
      ],
    });

    await router.handle("slack", "C123", "/team Team A");
    const result = await router.handle("slack", "C123", "/learn communication style");

    expect(onLearn).toHaveBeenCalledWith(
      "slack",
      "C123",
      "communication style",
      "team-a",
    );
    expect(render(result?.parts ?? [])).toContain('Learned 1 fact about "communication style"');
  });

  it("handles /learn with no topic argument", async () => {
    const onLearn = vi.fn(async (_channelType, _channelId, topic) => ({
      topic,
      extracted: 0,
      saved: 0,
      skipped: 0,
      savedFacts: [],
    }));
    const router = new CommandRouter({ onLearn, defaultTeamId: "default" });

    const result = await router.handle("discord", "D1", "/learn");

    expect(onLearn).toHaveBeenCalledWith("discord", "D1", undefined, "default");
    expect(render(result?.parts ?? [])).toBe("No learnable facts found in the current session.");
  });

  it("supports /remember for explicit facts", async () => {
    const onRemember = vi.fn(async (_channelType, _channelId, fact) => ({ saved: false, fact }));
    const router = new CommandRouter({ onRemember, defaultTeamId: "default" });

    const result = await router.handle("discord", "D1", "/remember User likes tea");

    expect(onRemember).toHaveBeenCalledWith("discord", "D1", "User likes tea", "default");
    expect(render(result?.parts ?? [])).toBe('Already known: "User likes tea"');
  });

  it("returns usage for empty /remember", async () => {
    const onRemember = vi.fn(async () => ({ saved: true, fact: "ignored" }));
    const router = new CommandRouter({ onRemember, defaultTeamId: "default" });

    const result = await router.handle("telegram", "42", "/remember");

    expect(onRemember).not.toHaveBeenCalled();
    expect(render(result?.parts ?? [])).toBe("Usage: /remember <fact>");
  });

  it("surfaces learn errors to the user", async () => {
    const onLearn = vi.fn(async () => {
      throw new Error("Memory is not enabled");
    });
    const router = new CommandRouter({ onLearn, defaultTeamId: "default" });

    const result = await router.handle("whatsapp", "100", "/learn");

    expect(render(result?.parts ?? [])).toBe("Memory is not enabled");
  });
});
