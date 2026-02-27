import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { tool, jsonSchema, type ToolSet } from "ai";
import type { McpServerConfig } from "../config.js";
import type { Integration } from "./types.js";
import { logger } from "../logger.js";

/** Agent name sent to MCP servers during initialization. */
const CLIENT_NAME = "mvp-agent";
const CLIENT_VERSION = "1.0.0";

/**
 * Format MCP tool result content array into a string for the model.
 */
function formatMcpResult(content: unknown): string {
  if (!Array.isArray(content)) return String(content);

  return content
    .map((item: Record<string, unknown>) => {
      if (item.type === "text") return item.text as string;
      if (item.type === "image") return `[image: ${item.mimeType}]`;
      if (item.type === "resource") {
        const resource = item.resource as Record<string, unknown>;
        return (resource.text as string) ?? `[resource: ${resource.uri}]`;
      }
      return JSON.stringify(item);
    })
    .join("\n");
}

/**
 * Create an Integration from an MCP server config.
 * Connects to the server, discovers tools, and wraps them as Vercel AI SDK tools.
 */
export async function createMcpIntegration(name: string, config: McpServerConfig): Promise<Integration> {
  const client = new Client(
    { name: CLIENT_NAME, version: CLIENT_VERSION },
    { capabilities: {} },
  );

  let transport: StdioClientTransport | SSEClientTransport;

  if (config.command && config.url) {
    logger.warn(`MCP server "${name}": both "command" and "url" specified; using "command" (stdio)`);
  }

  if (config.command) {
    transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: { ...process.env, ...config.env } as Record<string, string>,
    });
  } else if (config.url) {
    transport = new SSEClientTransport(new URL(config.url));
  } else {
    throw new Error(`MCP server "${name}": config must have either "command" (stdio) or "url" (SSE)`);
  }

  // Connect and discover tools
  await client.connect(transport);
  const { tools: mcpTools } = await client.listTools();

  // Convert MCP tools → Vercel AI SDK tools
  const tools: ToolSet = {};
  for (const mcpTool of mcpTools) {
    const toolName = mcpTool.name;
    tools[toolName] = tool({
      description: mcpTool.description ?? `MCP tool: ${toolName}`,
      inputSchema: jsonSchema<Record<string, unknown>>(
        mcpTool.inputSchema as Parameters<typeof jsonSchema>[0],
      ),
      execute: async (params) => {
        try {
          const result = await client.callTool({
            name: toolName,
            arguments: params,
          });

          if (result.isError) {
            return `Error: ${formatMcpResult(result.content)}`;
          }
          return formatMcpResult(result.content);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error(`MCP tool "${toolName}" failed: ${msg}`);
          return `Error calling ${toolName}: ${msg}`;
        }
      },
    });
  }

  const toolNames = Object.keys(tools).join(", ");

  return {
    id: `mcp:${name}`,
    name,
    source: "mcp" as const,
    tools: {
      tools,
      systemPrompt: [
        `## MCP: ${name}`,
        `Connected MCP server with tools: ${toolNames}.`,
      ].join("\n"),
      initialize: async () => {
        logger.info(
          `MCP server "${name}" connected (${config.command ? "stdio" : "sse"}, ${mcpTools.length} tools: ${toolNames})`,
        );
      },
      cleanup: async () => {
        try {
          await client.close();
          logger.info(`MCP server "${name}" disconnected`);
        } catch (err) {
          logger.warn(`MCP server "${name}" cleanup error: ${err instanceof Error ? err.message : err}`);
        }
      },
    },
  };
}
