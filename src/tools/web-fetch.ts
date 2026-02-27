import { tool } from "ai";
import { z } from "zod";

// TODO: phase 5 — improve with HTML→markdown conversion

export const webFetchTool = tool({
  description: "Fetch a URL and return its text content",
  inputSchema: z.object({
    url: z.string().url().describe("The URL to fetch"),
  }),
  execute: async ({ url }) => {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "mini-agent/0.1" },
        signal: AbortSignal.timeout(15_000),
      });
      const text = await res.text();
      return text.slice(0, 20_000); // cap size
    } catch (err: any) {
      return `Error fetching ${url}: ${err.message}`;
    }
  },
});
