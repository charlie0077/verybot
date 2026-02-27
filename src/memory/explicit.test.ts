import { describe, expect, it, vi } from "vitest";
import type { EmbeddingProvider } from "./embedding.js";
import { MAX_EXPLICIT_FACT_LENGTH, saveExplicitMemory } from "./explicit.js";

function createEmbeddingProviderMock(): EmbeddingProvider {
  return {
    id: "test",
    model: "test-model",
    ready: true,
    embed: vi.fn(async () => [0.1, 0.2]),
    embedBatch: vi.fn(async () => [[0.1, 0.2]]),
  };
}

describe("saveExplicitMemory", () => {
  it("trims fact and saves via store", async () => {
    const store = {
      save: vi.fn(() => true),
    } as any;
    const embeddingProvider = createEmbeddingProviderMock();

    const result = await saveExplicitMemory(store, embeddingProvider, {
      fact: "  User likes tea  ",
      source: "default:gateway:s1",
      teamId: "team-a",
    });

    expect(embeddingProvider.embed).toHaveBeenCalledWith("User likes tea");
    expect(store.save).toHaveBeenCalledWith(expect.objectContaining({
      fact: "User likes tea",
      source: "default:gateway:s1",
      teamId: "team-a",
      embedding: [0.1, 0.2],
    }));
    expect(result).toEqual({ saved: true, fact: "User likes tea" });
  });

  it("rejects empty fact", async () => {
    const store = { save: vi.fn(() => true) } as any;
    await expect(saveExplicitMemory(store, null, {
      fact: "   ",
      source: "default:gateway:s1",
    })).rejects.toThrow("fact cannot be empty");
  });

  it("rejects facts longer than limit", async () => {
    const store = { save: vi.fn(() => true) } as any;
    const tooLong = "a".repeat(MAX_EXPLICIT_FACT_LENGTH + 1);

    await expect(saveExplicitMemory(store, null, {
      fact: tooLong,
      source: "default:gateway:s1",
    })).rejects.toThrow(`fact exceeds maximum length of ${MAX_EXPLICIT_FACT_LENGTH}`);
  });
});
