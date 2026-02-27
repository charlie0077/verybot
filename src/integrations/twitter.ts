import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { TwitterApi } from "twitter-api-v2";
import type { Integration } from "./types.js";
import { logger } from "../logger.js";

const MAX_TWEET_LENGTH = 280;
const DEFAULT_SEARCH_LIMIT = 10;

interface TwitterConfig {
  bearerToken: string;
  apiKey?: string;
  apiSecret?: string;
  accessToken?: string;
  accessSecret?: string;
}

/** Zod schema for Twitter integration config. */
const twitterConfigSchema = z.object({
  bearerToken: z.string().min(1),
  apiKey: z.string().optional(),
  apiSecret: z.string().optional(),
  accessToken: z.string().optional(),
  accessSecret: z.string().optional(),
});

/** Flat config.json keys → TwitterConfig fields. */
const TWITTER_CONFIG_KEYS: Record<string, string> = {
  bearerToken: "TWITTER_BEARER_TOKEN",
  apiKey: "TWITTER_API_KEY",
  apiSecret: "TWITTER_API_SECRET",
  accessToken: "TWITTER_ACCESS_TOKEN",
  accessSecret: "TWITTER_ACCESS_SECRET",
};

export function createTwitterIntegration(config: TwitterConfig): Integration {
  // Read-only client (bearer token) for search
  const readClient = new TwitterApi(config.bearerToken);

  // Read-write client (OAuth 1.0a) for posting — only if credentials provided
  const hasWriteAccess =
    config.apiKey && config.apiSecret && config.accessToken && config.accessSecret;
  const writeClient = hasWriteAccess
    ? new TwitterApi({
        appKey: config.apiKey!,
        appSecret: config.apiSecret!,
        accessToken: config.accessToken!,
        accessSecret: config.accessSecret!,
      })
    : null;

  const tools: ToolSet = {
    twitter_search: tool({
      description: "Search for recent tweets matching a query",
      inputSchema: z.object({
        query: z.string().describe("Search query (Twitter search syntax)"),
        limit: z
          .number()
          .optional()
          .describe(`Max results (default: ${DEFAULT_SEARCH_LIMIT}, max: 100)`),
      }),
      execute: async ({ query, limit }) => {
        try {
          const result = await readClient.v2.search(query, {
            max_results: Math.min(limit ?? DEFAULT_SEARCH_LIMIT, 100),
            "tweet.fields": ["created_at", "author_id", "public_metrics"],
          });
          const tweets = result.data?.data;
          if (!tweets?.length) return "No tweets found.";
          return tweets
            .map((t) => {
              const metrics = t.public_metrics;
              const stats = metrics
                ? ` [${metrics.like_count} likes, ${metrics.retweet_count} RTs]`
                : "";
              return `@${t.author_id} (${t.created_at}): ${t.text}${stats}`;
            })
            .join("\n\n");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error(`twitter_search failed: ${msg}`);
          return `Error searching tweets: ${msg}`;
        }
      },
    }),
  };

  // Only register posting tool if write credentials are available
  if (writeClient) {
    tools.twitter_post = tool({
      description: `Post a tweet to Twitter/X (max ${MAX_TWEET_LENGTH} characters)`,
      inputSchema: z.object({
        text: z
          .string()
          .max(MAX_TWEET_LENGTH)
          .describe(`Tweet text (max ${MAX_TWEET_LENGTH} characters)`),
      }),
      execute: async ({ text }) => {
        try {
          const { data } = await writeClient.v2.tweet(text);
          return `Posted tweet: https://twitter.com/i/status/${data.id}`;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error(`twitter_post failed: ${msg}`);
          return `Error posting tweet: ${msg}`;
        }
      },
    });
  }

  const toolNames = Object.keys(tools).join(", ");
  return {
    id: "twitter",
    name: "twitter",
    source: "builtin",
    tools: {
      tools,
      systemPrompt: [
        "## Twitter/X Integration",
        `You have Twitter tools available: ${toolNames}.`,
        "- `twitter_search`: Search recent tweets (last 7 days)",
        writeClient ? "- `twitter_post`: Post a new tweet (max 280 characters)" : "",
      ]
        .filter(Boolean)
        .join("\n"),
      initialize: async () => {
        logger.info(
          `Twitter integration ready (search: yes, post: ${writeClient ? "yes" : "no — missing OAuth credentials"})`,
        );
      },
    },
    config: {
      schema: twitterConfigSchema,
      configKeys: TWITTER_CONFIG_KEYS,
    },
  };
}
