#!/usr/bin/env bun
/**
 * One-time migration: read .env.old and patch ~/.verybot/config.json
 * Usage: bun scripts/migrate-env.ts
 */
import { readFileSync } from "fs";
import { join } from "path";
import { ConfigStore } from "../src/config/store.js";
import { BASE_DIR, ensureDirs } from "../src/paths.js";

const ENV_FILE = join(import.meta.dirname, "../.env.old");

function parseEnvFile(path: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    // Strip surrounding quotes
    if ((val.startsWith("'") && val.endsWith("'")) || (val.startsWith('"') && val.endsWith('"'))) {
      val = val.slice(1, -1);
    }
    result[key] = val;
  }
  return result;
}

/** Map .env keys → config.json structure */
function envToConfig(env: Record<string, string>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};

  // Secrets (flat keys)
  const directKeys = [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "TELEGRAM_BOT_TOKEN",
    "DISCORD_BOT_TOKEN",
    "TWITTER_BEARER_TOKEN",
    "TWITTER_API_KEY",
    "TWITTER_API_SECRET",
    "TWITTER_ACCESS_TOKEN",
    "TWITTER_ACCESS_SECRET",
    "GITHUB_TOKEN",
    "GITHUB_DEFAULT_OWNER",
  ];
  for (const key of directKeys) {
    if (env[key] && env[key] !== "..." && env[key] !== "your_token_here") {
      patch[key] = env[key];
    }
  }

  // Gateway
  if (env.GATEWAY_TOKEN) patch.GATEWAY_TOKEN = env.GATEWAY_TOKEN;
  if (env.GATEWAY_PORT) {
    patch.gateway = { port: Number(env.GATEWAY_PORT) };
  }

  // Model
  if (env.DEFAULT_MODEL) patch.model = env.DEFAULT_MODEL;
  if (env.MAX_STEPS) patch.maxSteps = Number(env.MAX_STEPS);
  if (env.MODEL_CONTEXT_WINDOW) {
    patch.contextWindow = Number(env.MODEL_CONTEXT_WINDOW.replace(/_/g, ""));
  }

  // Browser
  if (env.BROWSER_HEADLESS) patch.browserHeadless = env.BROWSER_HEADLESS !== "false";

  // Language
  if (env.LANGUAGE) patch.language = env.LANGUAGE;

  // Sandbox
  if (env.DOCKER_SANDBOX === "true") {
    patch.sandbox = { enabled: true };
  }

  // Desktop
  if (env.DESKTOP_CONTROL === "true") {
    patch.desktop = { enabled: true };
  }

  // MCP servers
  if (env.MCP_SERVERS) {
    try {
      const servers = JSON.parse(env.MCP_SERVERS);
      if (Array.isArray(servers)) patch.mcp = { servers };
    } catch { /* skip */ }
  }

  return patch;
}

// --- Run ---
ensureDirs();
const env = parseEnvFile(ENV_FILE);
const patch = envToConfig(env);

const store = new ConfigStore(BASE_DIR);
store.patch(patch);

console.log("Migrated .env.old → ~/.verybot/config.json");
console.log("Patched keys:", Object.keys(patch).join(", "));
