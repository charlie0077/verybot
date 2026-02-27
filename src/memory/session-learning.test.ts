import { describe, expect, it, vi } from "vitest";
import type { LanguageModel } from "ai";
import { learnSessionMemories } from "./session-learning.js";

vi.mock("./extractor.js", () => ({
  extractFacts: vi.fn(async () => ["User likes tea", "User likes tea", "User dislikes spam"]),
}));

describe("learnSessionMemories", () => {
  it("extracts and persists facts from session messages", async () => {
    const save = vi
      .fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const memoryStore = { save } as any;

    const result = await learnSessionMemories({
      model: {} as LanguageModel,
      memoryStore,
      embeddingProvider: null,
      sessionKey: "default:gateway:s1",
      messages: [
        { role: "user", content: "I like tea and I dislike spam." },
      ],
      teamId: undefined,
      topic: "preferences",
    });

    expect(result.topic).toBe("preferences");
    expect(result.extracted).toBe(3);
    expect(result.saved).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.savedFacts).toEqual(["User likes tea", "User dislikes spam"]);
  });

  it("returns empty result when nothing is extracted", async () => {
    const { extractFacts } = await import("./extractor.js");
    vi.mocked(extractFacts).mockResolvedValueOnce([]);

    const result = await learnSessionMemories({
      model: {} as LanguageModel,
      memoryStore: { save: vi.fn() } as any,
      embeddingProvider: null,
      sessionKey: "default:gateway:s1",
      messages: [],
    });

    expect(result).toEqual({
      topic: undefined,
      extracted: 0,
      saved: 0,
      skipped: 0,
      savedFacts: [],
    });
  });

  it("skips extracted facts that fail to save", async () => {
    const save = vi
      .fn()
      .mockReturnValueOnce(true)
      .mockImplementationOnce(() => {
        throw new Error("write failed");
      })
      .mockReturnValueOnce(false);

    const result = await learnSessionMemories({
      model: {} as LanguageModel,
      memoryStore: { save } as any,
      embeddingProvider: null,
      sessionKey: "default:gateway:s1",
      messages: [{ role: "user", content: "I like tea and dislike spam." }],
    });

    expect(result.extracted).toBe(3);
    expect(result.saved).toBe(1);
    expect(result.skipped).toBe(2);
    expect(result.savedFacts).toEqual(["User likes tea"]);
  });
});
