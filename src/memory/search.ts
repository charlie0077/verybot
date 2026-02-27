import type { MemoryStore } from "./store.js";
import type { EmbeddingProvider } from "./embedding.js";
import { logger } from "../logger.js";

const VECTOR_WEIGHT = 0.7;
const TEXT_WEIGHT = 0.3;

export interface SearchOptions {
  limit?: number;
  embeddingProvider?: EmbeddingProvider | null;
  /** Restrict results to memories from this session source. */
  source?: string;
  /** When set, returns only team-specific memories. */
  teamId?: string;
}

/**
 * Hybrid memory search: runs FTS5 keyword search and (optionally) vector
 * similarity search in parallel, then merges and deduplicates results.
 */
export async function searchMemory(
  store: MemoryStore,
  query: string,
  options: SearchOptions = {},
): Promise<string[]> {
  const limit = options.limit ?? 5;

  try {
    const { source, teamId } = options;

    // FTS5 keyword search (always available)
    const textResults = store.searchByText(query, limit, source, teamId);

    // Vector search (only if embeddings available)
    let vectorResults: { id: string; fact: string }[] = [];
    if (options.embeddingProvider && store.hasVectorSearch) {
      try {
        const embedding = await options.embeddingProvider.embed(query);
        if (embedding) {
          vectorResults = store.searchByVector(embedding, limit, source, teamId);
        }
      } catch (err) {
        logger.warn(`Vector search failed: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Merge and deduplicate
    const scored = new Map<string, { fact: string; score: number }>();

    // Score vector results (higher rank = higher score, inversely proportional to index)
    for (let i = 0; i < vectorResults.length; i++) {
      const r = vectorResults[i];
      const vectorScore = 1 - i / vectorResults.length; // 1.0 → ~0.0
      scored.set(r.id, { fact: r.fact, score: VECTOR_WEIGHT * vectorScore });
    }

    // Score text results and merge
    for (let i = 0; i < textResults.length; i++) {
      const r = textResults[i];
      const textScore = 1 - i / textResults.length;
      const existing = scored.get(r.id);
      if (existing) {
        existing.score += TEXT_WEIGHT * textScore;
      } else {
        scored.set(r.id, { fact: r.fact, score: TEXT_WEIGHT * textScore });
      }
    }

    // Sort by combined score, return top N facts
    return Array.from(scored.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((r) => r.fact);
  } catch (err) {
    logger.error(`Memory search error: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}
