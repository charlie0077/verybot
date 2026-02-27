import type { ToolSet } from "ai";
import type { ConfigStore } from "../config/store.js";
import type { Config } from "../config.js";
import { INTEGRATIONS_DIR } from "../paths.js";
import type { Integration } from "./types.js";
import { createGithubIntegration } from "./github.js";
import { createTwitterIntegration } from "./twitter.js";
import { createMcpIntegration } from "./mcp.js";
import { scanUserIntegrations } from "./scanner.js";
import { logger } from "../logger.js";

/** Registry of builtin integration factories keyed by id. */
const BUILTIN_FACTORIES: Record<string, (config: Record<string, unknown>) => Integration> = {
  github: (c) => createGithubIntegration(c as never),
  twitter: (c) => createTwitterIntegration(c as never),
};

/**
 * Holds all available integrations (initialized at startup).
 * Tools are NOT registered globally — they are injected per-session
 * based on which integrations are active.
 */
export class IntegrationRegistry {
  private integrations = new Map<string, Integration>();
  private mcpConfigSignatures = new Map<string, string>();

  register(integration: Integration): void {
    this.integrations.set(integration.name, integration);
  }

  recordMcpConfigSignature(name: string, server: Config["mcpServers"][string]): void {
    this.mcpConfigSignatures.set(name, IntegrationRegistry.mcpSignature(server));
  }

  get(name: string): Integration | undefined {
    return this.integrations.get(name);
  }

  has(name: string): boolean {
    return this.integrations.has(name);
  }

  /** Get all available integration names. */
  get names(): string[] {
    return Array.from(this.integrations.keys());
  }

  /** Get tools for the given active integration names. */
  getToolsFor(active: Set<string>): ToolSet {
    const tools: ToolSet = {};
    for (const name of active) {
      const integration = this.integrations.get(name);
      if (integration) Object.assign(tools, integration.tools.tools);
    }
    return tools;
  }

  /** Get system prompts for the given active integration names. */
  getPromptsFor(active: Set<string>): string[] {
    const prompts: string[] = [];
    for (const name of active) {
      const integration = this.integrations.get(name);
      if (integration?.tools.systemPrompt) prompts.push(integration.tools.systemPrompt);
    }
    return prompts;
  }

  /** Clean up all integrations that have a cleanup method (e.g. MCP connections). */
  async cleanupAll(): Promise<void> {
    for (const [name, integration] of this.integrations) {
      if (integration.tools.cleanup) {
        try {
          await integration.tools.cleanup();
        } catch (err) {
          logger.warn(`Integration "${name}" cleanup failed: ${err instanceof Error ? err.message : err}`);
        }
      }
    }
  }

  /**
   * Re-discover builtin, user, and MCP integrations from the ConfigStore.
   * Adds newly-configured integrations, removes ones whose keys were deleted.
   */
  async refresh(store: ConfigStore, integrationsDir: string, config: Config): Promise<void> {
    try {
      await this.refreshBuiltins(store);
    } catch (err) {
      logger.error(`Builtin integration refresh failed: ${err instanceof Error ? err.message : err}`);
    }
    try {
      await this.refreshUserIntegrations(store, integrationsDir);
    } catch (err) {
      logger.error(`User integration refresh failed: ${err instanceof Error ? err.message : err}`);
    }
    try {
      await this.refreshMcpIntegrations(config);
    } catch (err) {
      logger.error(`MCP integration refresh failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Re-discover builtin integrations. */
  private async refreshBuiltins(store: ConfigStore): Promise<void> {
    for (const [id, factory] of Object.entries(BUILTIN_FACTORIES)) {
      const resolved = resolveBuiltinConfig(id, store);
      const existing = this.integrations.get(id);

      if (resolved && !existing) {
        const integration = factory(resolved);
        try {
          await integration.tools.initialize();
          this.register(integration);
          logger.info(`Integration "${id}" discovered and ready`);
        } catch (err) {
          logger.error(
            `Integration "${id}" failed to initialize: ${err instanceof Error ? err.message : err}`,
          );
        }
      } else if (!resolved && existing && existing.source !== "mcp" && existing.source !== "user") {
        if (existing.tools.cleanup) {
          try {
            await existing.tools.cleanup();
          } catch { /* best-effort */ }
        }
        this.integrations.delete(id);
        logger.info(`Integration "${id}" removed (config keys no longer present)`);
      }
    }
  }

  /** Re-discover user integrations from the integrations directory. */
  private async refreshUserIntegrations(store: ConfigStore, dir: string): Promise<void> {
    const scanned = await scanUserIntegrations(dir, store);
    const scannedIds = new Set(scanned.map((i) => i.id));

    // Remove user integrations that are no longer present on disk
    for (const [name, existing] of this.integrations) {
      if (existing.source === "user" && !scannedIds.has(existing.id)) {
        if (existing.tools.cleanup) {
          try {
            await existing.tools.cleanup();
          } catch { /* best-effort */ }
        }
        this.integrations.delete(name);
        logger.info(`User integration "${name}" removed (file no longer present)`);
      }
    }

    // Add/update user integrations
    for (const integration of scanned) {
      const existing = this.integrations.get(integration.name);
      if (existing) continue; // Already registered — skip re-init

      try {
        await integration.tools.initialize();
        this.register(integration);
        logger.info(
          `User integration "${integration.name}" ready (${Object.keys(integration.tools.tools).length} tools)`,
        );
      } catch (err) {
        logger.error(
          `User integration "${integration.name}" failed to initialize: ${err instanceof Error ? err.message : err} — skipping`,
        );
      }
    }
  }

  private static mcpSignature(server: Config["mcpServers"][string]): string {
    const sortedEnv = Object.fromEntries(
      Object.entries(server.env ?? {}).sort(([a], [b]) => a.localeCompare(b)),
    );
    return JSON.stringify({
      command: server.command ?? null,
      args: server.args ?? [],
      env: sortedEnv,
      url: server.url ?? null,
    });
  }

  /** Reconcile MCP integrations against config.mcpServers (add/update/remove). */
  private async refreshMcpIntegrations(config: Config): Promise<void> {
    const desiredNames = new Set(Object.keys(config.mcpServers));
    const existingMcp = [...this.integrations.values()].filter((i) => i.source === "mcp");

    // Remove deleted MCP servers.
    for (const integration of existingMcp) {
      if (desiredNames.has(integration.name)) continue;
      if (integration.tools.cleanup) {
        try {
          await integration.tools.cleanup();
        } catch {
          /* best-effort */
        }
      }
      this.integrations.delete(integration.name);
      this.mcpConfigSignatures.delete(integration.name);
      logger.info(`MCP integration "${integration.name}" removed (config entry deleted)`);
    }

    // Add or update configured MCP servers.
    for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
      const nextSignature = IntegrationRegistry.mcpSignature(serverConfig);
      const prevSignature = this.mcpConfigSignatures.get(name);
      const existing = this.integrations.get(name);
      const unchangedMcp = existing?.source === "mcp" && prevSignature === nextSignature;
      if (unchangedMcp) continue;

      if (existing?.source === "mcp") {
        if (existing.tools.cleanup) {
          try {
            await existing.tools.cleanup();
          } catch {
            /* best-effort */
          }
        }
        this.integrations.delete(name);
      }

      try {
        const integration = await createMcpIntegration(name, serverConfig);
        await integration.tools.initialize();
        this.register(integration);
        this.recordMcpConfigSignature(name, serverConfig);
        logger.info(`MCP integration "${name}" refreshed`);
      } catch (err) {
        logger.error(
          `MCP server "${name}" failed to refresh: ${err instanceof Error ? err.message : err} — skipping`,
        );
      }
    }
  }

  /** Build a compact listing of all available integrations for the system prompt. */
  buildListing(active?: Set<string>): string {
    if (this.integrations.size === 0) return "";

    const lines: string[] = [];
    for (const [name, integration] of this.integrations) {
      const toolNames = Object.keys(integration.tools.tools).join(", ");
      const status = active?.has(name) ? " (enabled)" : " (disabled)";
      const sourceTag =
        integration.source === "mcp" ? " [MCP]" :
        integration.source === "user" ? " [user]" : "";
      lines.push(`  - **${name}**${sourceTag}${status}: ${toolNames}`);
    }

    return `## Integrations
Integrations provide external tools (APIs, MCP servers, services). Items marked [MCP] are connected MCP servers. Items marked [user] are user-defined integrations.
You can enable or disable integrations mid-session using the \`enable_integration\` and \`disable_integration\` tools.
When the user asks about integrations, MCP servers, or available tools, refer to this list.

<available_integrations>
${lines.join("\n")}
</available_integrations>`;
  }
}

/**
 * Resolve config values for a builtin integration by reading flat keys
 * from the ConfigStore via the integration's ConfigAdapter.configKeys mapping.
 * Returns the assembled config object, or null if required keys are missing.
 */
function resolveBuiltinConfig(
  id: string,
  store: ConfigStore,
): Record<string, unknown> | null {
  const factory = BUILTIN_FACTORIES[id];
  if (!factory) return null;

  // Build a probe integration to extract ConfigAdapter metadata.
  // This is cheap — the factory doesn't call external APIs until initialize().
  const dummyConfig = getDummyConfig(id);
  const probe = factory(dummyConfig);
  if (!probe.config) return null;

  const data = store.load();
  const assembled: Record<string, unknown> = {};
  let hasRequired = false;

  for (const [field, flatKey] of Object.entries(probe.config.configKeys)) {
    const val = data[flatKey];
    if (typeof val === "string" && val) {
      assembled[field] = val;
      hasRequired = true;
    }
  }

  // Validate with the schema — if it fails, the required keys are missing
  const result = probe.config.schema.safeParse(assembled);
  if (!result.success) {
    if (hasRequired) {
      logger.warn(`Integration "${id}" config incomplete: ${result.error.message}`);
    }
    return null;
  }

  return assembled;
}

/** Minimal dummy config per integration id (never hits network). */
function getDummyConfig(id: string): Record<string, unknown> {
  switch (id) {
    case "github":
      return { token: "dummy" };
    case "twitter":
      return { bearerToken: "dummy" };
    default:
      return {};
  }
}

/**
 * Initialize all configured integrations and return a registry.
 * Builtin integrations are auto-discovered via ConfigAdapter.configKeys.
 * User integrations are loaded from the integrations directory.
 * MCP servers are loaded from config.mcpServers.
 * Continues past individual failures (logs error, skips that integration).
 */
export async function loadIntegrations(
  config: Config,
  store: ConfigStore,
): Promise<IntegrationRegistry> {
  const registry = new IntegrationRegistry();
  const candidates: Integration[] = [];

  // Auto-discover builtin integrations via ConfigAdapter
  for (const [id, factory] of Object.entries(BUILTIN_FACTORIES)) {
    const resolved = resolveBuiltinConfig(id, store);
    if (resolved) {
      candidates.push(factory(resolved));
    }
  }

  // User integrations from directory
  try {
    const userIntegrations = await scanUserIntegrations(INTEGRATIONS_DIR, store);
    candidates.push(...userIntegrations);
  } catch (err) {
    logger.error(`User integration scan failed: ${err instanceof Error ? err.message : err}`);
  }

  // MCP servers (no ConfigAdapter — loaded from config.mcpServers)
  for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
    try {
      const integration = await createMcpIntegration(name, serverConfig);
      candidates.push(integration);
    } catch (err) {
      logger.error(
        `MCP server "${name}" failed to connect: ${err instanceof Error ? err.message : err} — skipping`,
      );
    }
  }

  for (const integration of candidates) {
    try {
      await integration.tools.initialize();
      registry.register(integration);
      if (integration.source === "mcp") {
        const serverConfig = config.mcpServers[integration.name];
        if (serverConfig) registry.recordMcpConfigSignature(integration.name, serverConfig);
      }
      logger.info(
        `Integration "${integration.name}" ready (${Object.keys(integration.tools.tools).length} tools)`,
      );
    } catch (err) {
      logger.error(
        `Integration "${integration.name}" failed to initialize: ${err instanceof Error ? err.message : err} — skipping`,
      );
    }
  }

  return registry;
}
