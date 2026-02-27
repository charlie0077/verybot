import type { ToolSet } from "ai";
import type { ZodType } from "zod";

export interface ToolAdapter {
  tools: ToolSet;
  /** Optional system prompt section with usage guidance */
  systemPrompt?: string;
  /** Initialize the integration (validate credentials, etc.) */
  initialize(): Promise<void>;
  /** Clean up resources (close connections, kill subprocesses). */
  cleanup?(): Promise<void>;
}

export interface ConfigAdapter {
  /** Zod schema describing the config fields this integration needs */
  schema: ZodType;
  /** Which flat keys from config.json map to this integration's config.
   *  Key = integration config field name, value = config.json flat key.
   *  e.g. { token: "GITHUB_TOKEN", defaultOwner: "GITHUB_DEFAULT_OWNER" }
   */
  configKeys: Record<string, string>;
}

export interface Integration {
  /** Machine identifier (e.g. "github", "twitter") */
  id: string;
  /** Human-readable display name */
  name: string;
  /** Source type: "builtin" for GitHub/Twitter, "mcp" for MCP servers, "user" for user-defined. */
  source?: "builtin" | "mcp" | "user";
  tools: ToolAdapter;
  config?: ConfigAdapter;
}

/**
 * What a user integration file default-exports.
 * Drop a .ts/.js file in ~/.verybot/integrations/ with this shape.
 *
 * Example:
 * ```ts
 * import { tool } from "ai";
 * import { z } from "zod";
 *
 * export default {
 *   id: "weather",
 *   name: "Weather",
 *   configKeys: { apiKey: "WEATHER_API_KEY" },
 *   create(config) {
 *     return {
 *       tools: { weather_get: tool({ ... }) },
 *       systemPrompt: "You have a weather tool.",
 *       async initialize() { },
 *     };
 *   },
 * } satisfies IntegrationDefinition;
 * ```
 */
export interface IntegrationDefinition {
  /** Unique machine identifier */
  id: string;
  /** Human-readable display name */
  name: string;
  /**
   * Maps integration config field names to flat config.json keys.
   * The scanner resolves these from the ConfigStore before calling create().
   * If a required key (per the Zod schema) is missing, the integration is skipped.
   */
  configKeys?: Record<string, string>;
  /** Optional Zod schema to validate the resolved config. */
  configSchema?: ZodType;
  /**
   * Factory that receives the resolved config object and returns a ToolAdapter.
   * Called only if configKeys resolve successfully (or if configKeys is omitted).
   */
  create(config: Record<string, unknown>): ToolAdapter | Promise<ToolAdapter>;
}
