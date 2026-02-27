import { randomUUID } from "crypto";
import type { MemoryStore } from "./store.js";
import type { EmbeddingProvider } from "./embedding.js";

export const MAX_EXPLICIT_FACT_LENGTH = 2000;

export interface SaveExplicitMemoryInput {
  fact: string;
  source: string;
  teamId?: string;
}

export interface SaveExplicitMemoryResult {
  saved: boolean;
  fact: string;
}

/**
 * Save one user-provided fact to long-term memory with consistent validation.
 */
export async function saveExplicitMemory(
  store: MemoryStore,
  embeddingProvider: EmbeddingProvider | null,
  input: SaveExplicitMemoryInput,
): Promise<SaveExplicitMemoryResult> {
  if (typeof input.fact !== "string") {
    throw new Error("fact is required");
  }

  const fact = input.fact.trim();
  if (fact.length === 0) {
    throw new Error("fact cannot be empty");
  }

  if (fact.length > MAX_EXPLICIT_FACT_LENGTH) {
    throw new Error(`fact exceeds maximum length of ${MAX_EXPLICIT_FACT_LENGTH}`);
  }

  const embedding = embeddingProvider
    ? await embeddingProvider.embed(fact) ?? undefined
    : undefined;

  const saved = store.save({
    id: randomUUID(),
    fact,
    source: input.source,
    timestamp: Date.now(),
    teamId: input.teamId,
    embedding,
  });

  return { saved, fact };
}
