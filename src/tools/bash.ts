import { tool, type Tool } from "ai";
import { z } from "zod";
import { execSync } from "child_process";
import type { BashConfig } from "../config.js";
import type { DockerSandbox } from "../security/docker-sandbox.js";
import { validateCommand, isAllowed, DEFAULT_SAFE_BINS } from "../security/command-validator.js";
import { sanitizeEnv } from "../security/env-filter.js";
import { logger } from "../logger.js";

const EXEC_TIMEOUT = 30_000;
const MAX_OUTPUT = 10_000;
const MAX_ERROR = 5_000;

/** Per-run context injected when creating the bash tool inside Agent.run(). */
export interface BashToolContext {
  sessionKey: string;
  sandbox: DockerSandbox | null;
  /** Optional host working directory for command execution. */
  cwd?: string;
}

/**
 * Create a bash tool with the given security config and optional per-run context.
 * Returns null in "deny" mode (tool not registered at all).
 *
 * When `ctx.sandbox` is provided, commands execute inside a Docker container.
 * Otherwise, commands execute on the host with sanitized environment.
 */
export function createBashTool(config: BashConfig, ctx?: BashToolContext): Tool | null {
  if (config.security === "deny") return null;

  // Merge user-provided safe bins with defaults
  const safeBins = new Set([...DEFAULT_SAFE_BINS, ...config.safeBins]);

  return tool({
    description:
      "Execute a shell command. Confirm with user before destructive commands (rm, mv, chmod). " +
      "Backticks, $(), redirects, and subshells are blocked.",
    inputSchema: z.object({
      command: z.string().describe("The shell command to execute"),
    }),
    execute: async ({ command }) => {
      // 1. Always validate syntax (blocks dangerous tokens in all modes)
      const validation = validateCommand(command);
      if (!validation.ok) {
        logger.warn(`Bash blocked (syntax): ${validation.reason} — ${command}`);
        return `Blocked: ${validation.reason}`;
      }

      // 2. In allowlist mode, check executables against safe bins + allowlist
      if (config.security === "allowlist") {
        if (!isAllowed(command, safeBins, config.allowlist)) {
          logger.warn(`Bash blocked (allowlist): ${command}`);
          return `Blocked: command not in allowlist. Safe bins: ${[...safeBins].join(", ")}`;
        }
      }

      // 3. Execute — sandbox if available, otherwise host
      if (ctx?.sandbox) {
        return ctx.sandbox.exec(ctx.sessionKey, command);
      }

      try {
        const cwd = ctx?.cwd?.trim() || undefined;
        const output = execSync(command, {
          encoding: "utf-8",
          timeout: EXEC_TIMEOUT,
          maxBuffer: 1024 * 1024,
          env: sanitizeEnv(),
          cwd,
        });
        return output.slice(0, MAX_OUTPUT);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        const stderr = (err as { stderr?: string }).stderr ?? "";
        return `Error: ${msg}\n${stderr}`.slice(0, MAX_ERROR);
      }
    },
  });
}
