import { readdir, stat } from "fs/promises";
import { join, resolve } from "path";
import type { ConfigStore } from "../config/store.js";
import type { Integration, IntegrationDefinition } from "./types.js";
import { logger } from "../logger.js";

/** File extensions we attempt to import as integration modules. */
const IMPORTABLE_EXTENSIONS = new Set([".ts", ".js", ".mjs"]);

/**
 * Scan a directory for user integration files, resolve their config
 * from the ConfigStore, and return ready-to-register Integrations.
 *
 * Each file must default-export an IntegrationDefinition.
 * Files whose required config keys are missing are silently skipped.
 */
export async function scanUserIntegrations(
  dir: string,
  store: ConfigStore,
): Promise<Integration[]> {
  const absDir = resolve(dir);
  let entries: string[];
  try {
    entries = await readdir(absDir);
  } catch {
    // Directory doesn't exist yet — not an error
    return [];
  }

  const integrations: Integration[] = [];
  const seenIds = new Set<string>();

  for (const entry of entries) {
    const ext = entry.slice(entry.lastIndexOf("."));
    if (!IMPORTABLE_EXTENSIONS.has(ext)) continue;

    const filePath = join(absDir, entry);
    const fileStat = await stat(filePath).catch(() => null);
    if (!fileStat?.isFile()) continue;

    try {
      const integration = await loadUserIntegration(filePath, store);
      if (!integration) continue; // config keys not present — skip silently

      if (seenIds.has(integration.id)) {
        logger.warn(`Duplicate user integration id "${integration.id}" at ${filePath}, skipping`);
        continue;
      }
      seenIds.add(integration.id);
      integrations.push(integration);
    } catch (err) {
      logger.error(
        `User integration "${entry}" failed to load: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  return integrations;
}

/**
 * Import a single user integration file, resolve config, and return an Integration.
 * Returns null if required config keys are missing.
 */
async function loadUserIntegration(
  filePath: string,
  store: ConfigStore,
): Promise<Integration | null> {
  // Dynamic import — Bun handles .ts natively
  const mod = await import(filePath);
  const def: IntegrationDefinition = mod.default ?? mod;

  if (!def.id || typeof def.id !== "string") {
    throw new Error("Missing or invalid 'id' (must be a non-empty string)");
  }
  if (!def.name || typeof def.name !== "string") {
    throw new Error("Missing or invalid 'name' (must be a non-empty string)");
  }
  if (typeof def.create !== "function") {
    throw new Error("Missing 'create' function");
  }

  // Resolve config from ConfigStore using configKeys mapping
  const config = resolveConfig(def, store);
  if (config === null) return null;

  const toolAdapter = await def.create(config);

  // Validate the returned ToolAdapter shape
  if (!toolAdapter || typeof toolAdapter !== "object") {
    throw new Error("create() must return a ToolAdapter object");
  }
  if (!toolAdapter.tools || typeof toolAdapter.tools !== "object") {
    throw new Error("create() returned ToolAdapter missing 'tools' (must be a ToolSet object)");
  }
  if (typeof toolAdapter.initialize !== "function") {
    throw new Error("create() returned ToolAdapter missing 'initialize' (must be a function)");
  }

  return {
    id: def.id,
    name: def.name,
    source: "user",
    tools: toolAdapter,
    config: def.configKeys
      ? {
          schema: def.configSchema ?? noopSchema,
          configKeys: def.configKeys,
        }
      : undefined,
  };
}

/**
 * Resolve flat config keys from the ConfigStore into a config object.
 * Returns null if validation fails (required keys missing).
 */
function resolveConfig(
  def: IntegrationDefinition,
  store: ConfigStore,
): Record<string, unknown> | null {
  if (!def.configKeys) return {};

  const data = store.load();
  const assembled: Record<string, unknown> = {};

  for (const [field, flatKey] of Object.entries(def.configKeys)) {
    const val = data[flatKey];
    if (typeof val === "string" && val) {
      assembled[field] = val;
    }
  }

  // Validate with schema if provided
  if (def.configSchema) {
    const result = def.configSchema.safeParse(assembled);
    if (!result.success) return null;
  }

  return assembled;
}

/** Passthrough schema for integrations without configSchema. */
const noopSchema = {
  safeParse: (val: unknown) => ({ success: true as const, data: val }),
  parse: (val: unknown) => val,
} as import("zod").ZodType;
