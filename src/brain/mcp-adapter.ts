import http from "node:http";
import { randomUUID } from "node:crypto";
import type { LanguageModel, ToolSet } from "ai";
import { createCustomMcpServer, createClaudeCode } from "ai-sdk-provider-claude-code";
import { createCodexCli } from "ai-sdk-provider-codex-cli";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { CodexReasoningEffort } from "../config/model-spec.js";
import { logger } from "../logger.js";
import { CLAUDE_CODE_PROVIDER, CODEX_CLI_PROVIDER, CODEX_CLI_ENV } from "./providers.js";

/** Tool names that use Anthropic's proprietary format and should be skipped. */
const SKIP_TOOLS = new Set(["computer"]);

const MCP_SERVER_NAME = "verybot-tools";
const MCP_HTTP_PATH = "/mcp";

/** Force OAuth login by clearing API key from the SDK environment. */
const CLAUDE_CODE_ENV = { ANTHROPIC_API_KEY: undefined } as const;

// ---------------------------------------------------------------------------
// Port pool — allocate from a fixed range and reclaim on cleanup
// ---------------------------------------------------------------------------

const MCP_PORT_RANGE_START = 19400;
const MCP_PORT_RANGE_END = 19999;

const availablePorts = new Set(
  Array.from({ length: MCP_PORT_RANGE_END - MCP_PORT_RANGE_START + 1 }, (_, i) => MCP_PORT_RANGE_START + i),
);

function allocatePort(): number {
  const port = availablePorts.values().next().value;
  if (port === undefined) throw new Error(`No available MCP ports in range ${MCP_PORT_RANGE_START}-${MCP_PORT_RANGE_END}`);
  availablePorts.delete(port);
  return port;
}

function releasePort(port: number): void {
  availablePorts.add(port);
}

// ---------------------------------------------------------------------------
// Adapted result type
// ---------------------------------------------------------------------------

export interface AdaptedTools {
  model: LanguageModel;
  tools: ToolSet;
  /** Cleanup function to shut down any HTTP MCP servers (Codex CLI strategy). */
  cleanup?: () => Promise<void>;
}

/** Options forwarded to adapt strategies. */
export interface AdaptOptions {
  sandboxEnabled?: boolean;
  codexReasoningEffort?: CodexReasoningEffort;
  /** Optional working directory for provider CLI execution. */
  cwd?: string;
}

type AdaptStrategy = (
  modelId: string,
  model: LanguageModel,
  tools: ToolSet,
  options: AdaptOptions,
) => AdaptedTools | Promise<AdaptedTools>;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Extracted tool entry from an AI SDK ToolSet. */
interface UsableTool {
  name: string;
  description: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}

/** Extract the usable tools from an AI SDK ToolSet (skips proprietary / incomplete tools). */
export function extractUsableTools(tools: ToolSet): UsableTool[] {
  const result: UsableTool[] = [];

  for (const [name, tool] of Object.entries(tools)) {
    if (SKIP_TOOLS.has(name)) {
      logger.info(`[mcp-adapter]   skip "${name}" (proprietary format)`);
      continue;
    }

    const { description, inputSchema, execute } = tool as {
      description?: string;
      inputSchema?: z.ZodObject<z.ZodRawShape>;
      execute?: (args: Record<string, unknown>) => Promise<unknown>;
    };

    if (!execute || !inputSchema) {
      logger.info(`[mcp-adapter]   skip "${name}" — execute=${!!execute} inputSchema=${!!inputSchema}`);
      continue;
    }

    logger.info(`[mcp-adapter]   + "${name}"`);
    result.push({ name, description: description ?? name, inputSchema, execute });
  }

  return result;
}

/** Serialize a tool result into a string for MCP text content. */
function formatResult(result: unknown): string {
  if (result === undefined || result === null) return "";
  if (typeof result === "string") return result;
  if (Buffer.isBuffer(result)) return `[binary ${result.length} bytes]`;
  if (typeof result === "object" && "data" in result && Buffer.isBuffer((result as { data: unknown }).data)) {
    return `[image ${((result as { data: Buffer }).data).length} bytes]`;
  }
  return JSON.stringify(result);
}

/** Wrap an execute function in the MCP CallToolResult envelope. */
function wrapToolHandler(name: string, execute: UsableTool["execute"]) {
  return async (args: Record<string, unknown>) => {
    try {
      const result = await execute(args);
      return { content: [{ type: "text" as const, text: formatResult(result) }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`[mcp-adapter] Tool "${name}" error: ${message}`);
      return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  };
}

// ---------------------------------------------------------------------------
// Claude Code in-process MCP server (unchanged behavior)
// ---------------------------------------------------------------------------

/**
 * Convert an AI SDK ToolSet into a Claude Code MCP server config.
 * Each tool's `inputSchema` (Zod) is passed through directly,
 * and `execute` is wrapped in the MCP `handler` envelope.
 */
export function toolSetToMcpServer(
  tools: ToolSet,
  serverName = MCP_SERVER_NAME,
): McpSdkServerConfigWithInstance {
  const usable = extractUsableTools(tools);
  logger.info(`[mcp-adapter] Converting ${Object.keys(tools).length} AI SDK tools for server "${serverName}"`);

  const mcpTools: Record<string, {
    description: string;
    inputSchema: z.ZodObject<z.ZodRawShape>;
    handler: ReturnType<typeof wrapToolHandler>;
  }> = {};

  for (const { name, description, inputSchema, execute } of usable) {
    mcpTools[name] = { description, inputSchema, handler: wrapToolHandler(name, execute) };
  }

  const toolCount = Object.keys(mcpTools).length;
  logger.info(`[mcp-adapter] Registered ${toolCount} tools as MCP server "${serverName}"`);

  return createCustomMcpServer({ name: serverName, tools: mcpTools });
}

// ---------------------------------------------------------------------------
// Strategy: Claude Code (in-process MCP)
// ---------------------------------------------------------------------------

function claudeCodeStrategy(
  modelId: string,
  _model: LanguageModel,
  tools: ToolSet,
  options: AdaptOptions,
): AdaptedTools {
  const mcpServer = toolSetToMcpServer(tools);

  const claudeCode = createClaudeCode({
    defaultSettings: {
      permissionMode: "bypassPermissions",
      env: CLAUDE_CODE_ENV,
      mcpServers: { [MCP_SERVER_NAME]: mcpServer },
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.sandboxEnabled && { sandbox: { enabled: true } }),
      verbose: logger.level === "debug",
      logger: {
        debug: (msg: string) => logger.debug(`[claude-code-sdk] ${msg}`),
        info: (msg: string) => logger.info(`[claude-code-sdk] ${msg}`),
        warn: (msg: string) => logger.warn(`[claude-code-sdk] ${msg}`),
        error: (msg: string) => logger.error(`[claude-code-sdk] ${msg}`),
      },
    },
  });

  logger.info(`[mcp-adapter] Created claude-code provider with MCP server "${MCP_SERVER_NAME}" for model "${modelId}"`);

  return {
    model: claudeCode(modelId, { streamingInput: "always" }),
    tools: {}, // tools are in the MCP server; pass empty set to AI SDK
  };
}

// ---------------------------------------------------------------------------
// Strategy: Codex CLI (external HTTP MCP server)
// ---------------------------------------------------------------------------

/** Start an HTTP MCP server on loopback with the given tools registered. */
export async function startHttpMcpServer(usable: UsableTool[]): Promise<{
  url: string;
  cleanup: () => Promise<void>;
}> {
  const mcpServer = new McpServer(
    { name: MCP_SERVER_NAME, version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  for (const { name, description, inputSchema, execute } of usable) {
    mcpServer.tool(name, description, inputSchema.shape, async (args) => {
      return wrapToolHandler(name, execute)(args as Record<string, unknown>);
    });
  }

  // Codex performs multiple MCP requests per run (initialize, list tools, calls).
  // Streamable HTTP transport must therefore be stateful across requests.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  await mcpServer.connect(transport);

  const createHandler = () => http.createServer(async (req, res) => {
    const rawUrl = req.url ?? "";
    let pathname = rawUrl;
    try {
      pathname = new URL(rawUrl, "http://127.0.0.1").pathname;
    } catch {
      // Keep raw value when URL parsing fails.
    }
    const normalizedPath =
      pathname.endsWith("/") && pathname.length > 1 ? pathname.slice(0, -1) : pathname;

    if (normalizedPath !== MCP_HTTP_PATH) {
      res.writeHead(404).end("Not Found");
      return;
    }
    try {
      await transport.handleRequest(req, res);
    } catch (err) {
      logger.error(`[mcp-adapter] HTTP MCP request error: ${err instanceof Error ? err.message : err}`);
      if (!res.headersSent) {
        res.writeHead(500).end("Internal Server Error");
      }
    }
  });

  // Try up to MAX_PORT_RETRIES ports in case one is already in use externally
  const MAX_PORT_RETRIES = 3;
  let port = 0;
  let httpServer!: http.Server;
  for (let attempt = 0; attempt < MAX_PORT_RETRIES; attempt++) {
    port = allocatePort();
    httpServer = createHandler();
    httpServer.unref(); // allow process to exit even if cleanup is missed
    try {
      await new Promise<void>((resolve, reject) => {
        httpServer.listen(port, "127.0.0.1", () => resolve());
        httpServer.on("error", reject);
      });
      break;
    } catch (err) {
      releasePort(port);
      if (attempt === MAX_PORT_RETRIES - 1) throw err;
      logger.warn(`[mcp-adapter] Port ${port} in use, retrying with another port`);
    }
  }

  const url = `http://127.0.0.1:${port}${MCP_HTTP_PATH}`;
  logger.info(`[mcp-adapter] HTTP MCP server listening on ${url} (${usable.length} tools)`);

  const cleanup = async () => {
    logger.info(`[mcp-adapter] Shutting down HTTP MCP server on port ${port}`);
    await mcpServer.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    releasePort(port);
  };

  return { url, cleanup };
}

async function codexCliStrategy(
  modelId: string,
  _model: LanguageModel,
  tools: ToolSet,
  options: AdaptOptions,
): Promise<AdaptedTools> {
  const usable = extractUsableTools(tools);
  logger.info(`[mcp-adapter] Setting up Codex CLI HTTP MCP server for model "${modelId}"`);

  const { url, cleanup } = await startHttpMcpServer(usable);

  // Match "bypass all permissions": disable Codex CLI approvals and sandbox.
  const codexCli = createCodexCli({
    defaultSettings: {
      dangerouslyBypassApprovalsAndSandbox: true,
      env: CODEX_CLI_ENV,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.codexReasoningEffort ? { reasoningEffort: options.codexReasoningEffort } : {}),
      rmcpClient: true,
      mcpServers: {
        [MCP_SERVER_NAME]: { transport: "http", url },
      },
      verbose: logger.level === "debug",
      logger: {
        debug: (msg: string) => logger.debug(`[codex-cli-sdk] ${msg}`),
        info: (msg: string) => logger.info(`[codex-cli-sdk] ${msg}`),
        warn: (msg: string) => logger.warn(`[codex-cli-sdk] ${msg}`),
        error: (msg: string) => logger.error(`[codex-cli-sdk] ${msg}`),
      },
    },
  });

  return {
    model: codexCli(modelId),
    tools: {}, // tools are in the MCP server; pass empty set to AI SDK
    cleanup,
  };
}

// ---------------------------------------------------------------------------
// Strategy dispatcher
// ---------------------------------------------------------------------------

const STRATEGIES: Record<string, AdaptStrategy> = {
  [CLAUDE_CODE_PROVIDER]: claudeCodeStrategy,
  [CODEX_CLI_PROVIDER]: codexCliStrategy,
};

/**
 * Adapt tools for MCP-based providers (Claude Code, Codex CLI).
 * Non-MCP providers pass through unchanged.
 */
export async function adaptTools(
  provider: string,
  modelId: string,
  model: LanguageModel,
  tools: ToolSet,
  options: AdaptOptions = {},
): Promise<AdaptedTools> {
  const strategy = STRATEGIES[provider];
  if (!strategy) return { model, tools };
  return strategy(modelId, model, tools, options);
}
