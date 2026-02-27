import { tool, type Tool } from "ai";
import { z } from "zod";
import type { MemoryStore } from "../memory/store.js";
import type { EmbeddingProvider } from "../memory/embedding.js";
import { searchMemory } from "../memory/search.js";
import { saveExplicitMemory } from "../memory/explicit.js";

/**
 * Create a session-scoped memory_search tool.
 * Called per-run so results are restricted to the current session's memories.
 */
export function createMemorySearchTool(
  store: MemoryStore,
  embeddingProvider: EmbeddingProvider | null,
  maxResults: number,
  teamId?: string,
): Tool {
  return tool({
    description:
      "Search long-term memory for facts about this user. " +
      "ALWAYS call BEFORE responding to personal questions (name, location, preferences, history). " +
      "Call multiple times with different queries to gather all relevant facts. " +
      "When in doubt, search — it is fast.",
    inputSchema: z.object({
      query: z
        .string()
        .describe("What to search for, e.g. 'favorite food' or 'project details'"),
    }),
    execute: async ({ query }) => {
      const facts = await searchMemory(store, query, {
        limit: maxResults,
        embeddingProvider,
        teamId,
      });
      if (facts.length === 0) return "No relevant memories found.";
      return facts.map((f, i) => `${i + 1}. ${f}`).join("\n");
    },
  });
}

/**
 * Create a session-scoped memory_save tool.
 * Allows the agent to explicitly persist facts when the user asks to remember something.
 */
export function createMemorySaveTool(
  store: MemoryStore,
  embeddingProvider: EmbeddingProvider | null,
  sessionKey: string,
  teamId?: string,
): Tool {
  return tool({
    description:
      "Save a fact about the user to long-term memory. Use this when the user " +
      "explicitly asks you to remember something, or shares personal information " +
      "they expect you to retain (name, location, preferences, etc.). " +
      "Each call saves ONE atomic fact — call multiple times for multiple facts.",
    inputSchema: z.object({
      fact: z
        .string()
        .describe(
          "A single factual statement to remember, e.g. 'User lives in Singapore' " +
          "or 'User's favorite food is noodles'",
        ),
    }),
    execute: async ({ fact }) => {
      const { saved, fact: normalizedFact } = await saveExplicitMemory(store, embeddingProvider, {
        fact,
        source: sessionKey,
        teamId,
      });

      return saved
        ? `Saved: "${normalizedFact}"`
        : `Already known: "${normalizedFact}"`;
    },
  });
}
