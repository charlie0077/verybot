import { describe, it, expect, vi, afterEach } from "vitest";
import { z } from "zod";
import type { ToolSet } from "ai";
import { adaptTools, extractUsableTools, startHttpMcpServer } from "./mcp-adapter.js";

// Stub the logger to silence output during tests
vi.mock("../logger.js", () => ({
  logger: {
    level: "silent",
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

/** Create a minimal mock LanguageModel for testing. */
function mockModel(id = "test-model") {
  return { modelId: id, provider: "test" } as never;
}

/** Create a minimal AI SDK tool with execute + inputSchema. */
function fakeTool(name: string, returnValue: unknown = "ok") {
  return {
    [name]: {
      description: `${name} tool`,
      inputSchema: z.object({ input: z.string() }),
      execute: vi.fn().mockResolvedValue(returnValue),
    },
  } satisfies ToolSet;
}

describe("extractUsableTools", () => {
  it("extracts tools with execute and inputSchema", () => {
    const tools = { ...fakeTool("greet"), ...fakeTool("farewell") };
    const usable = extractUsableTools(tools);
    expect(usable).toHaveLength(2);
    expect(usable.map((t) => t.name)).toEqual(["greet", "farewell"]);
  });

  it("skips tools named 'computer' (proprietary)", () => {
    const tools: ToolSet = {
      computer: {
        description: "proprietary",
        inputSchema: z.object({}),
        execute: vi.fn(),
      },
      ...fakeTool("valid"),
    };
    const usable = extractUsableTools(tools);
    expect(usable).toHaveLength(1);
    expect(usable[0].name).toBe("valid");
  });

  it("skips tools without execute", () => {
    const tools: ToolSet = {
      noExec: {
        description: "no execute",
        inputSchema: z.object({ x: z.number() }),
      } as never,
    };
    const usable = extractUsableTools(tools);
    expect(usable).toHaveLength(0);
  });

  it("skips tools without inputSchema", () => {
    const tools: ToolSet = {
      noSchema: {
        description: "no schema",
        execute: vi.fn(),
      } as never,
    };
    const usable = extractUsableTools(tools);
    expect(usable).toHaveLength(0);
  });

  it("uses tool name as description when description is missing", () => {
    const tools: ToolSet = {
      unnamed: {
        inputSchema: z.object({}),
        execute: vi.fn(),
      } as never,
    };
    const usable = extractUsableTools(tools);
    expect(usable).toHaveLength(1);
    expect(usable[0].description).toBe("unnamed");
  });
});

describe("adaptTools", () => {
  it("returns passthrough for unknown providers", async () => {
    const tools = fakeTool("test");
    const model = mockModel();
    const result = await adaptTools("anthropic", "claude-3", model, tools);
    expect(result.model).toBe(model);
    expect(result.tools).toBe(tools);
    expect(result.cleanup).toBeUndefined();
  });

  it("returns empty tools for claude-code provider (tools moved to MCP server)", async () => {
    const tools = fakeTool("test");
    const model = mockModel();
    const result = await adaptTools("claude-code", "sonnet", model, tools);
    expect(result.tools).toEqual({});
    expect(result.cleanup).toBeUndefined();
  });
});

describe("startHttpMcpServer", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.allSettled(cleanups.map((fn) => fn()));
    cleanups.length = 0;
  });

  it("starts HTTP server, serves /mcp, and returns cleanup", async () => {
    const usable = extractUsableTools(fakeTool("echo"));
    const { url, cleanup } = await startHttpMcpServer(usable);
    cleanups.push(cleanup);

    const res = await fetch(url, { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } });
    // MCP protocol returns a JSON-RPC error for invalid requests, but the server is reachable
    expect(res.status).toBeLessThan(500);
  });

  it("handles multiple sequential /mcp requests", async () => {
    const usable = extractUsableTools(fakeTool("echo"));
    const { url, cleanup } = await startHttpMcpServer(usable);
    cleanups.push(cleanup);

    const req = {
      method: "POST",
      body: "{}",
      headers: { "Content-Type": "application/json" },
    } as const;

    const first = await fetch(url, req);
    const second = await fetch(url, req);

    // Reused transport must stay healthy across requests (no 500).
    expect(first.status).toBeLessThan(500);
    expect(second.status).toBeLessThan(500);
  });

  it("returns 404 for non-/mcp paths", async () => {
    const usable = extractUsableTools(fakeTool("echo"));
    const { url, cleanup } = await startHttpMcpServer(usable);
    cleanups.push(cleanup);

    // Replace /mcp with /other to hit a non-existent path
    const baseUrl = url.replace("/mcp", "/other");
    const res = await fetch(baseUrl);
    expect(res.status).toBe(404);
  });

  it("releases port after cleanup", async () => {
    const usable = extractUsableTools(fakeTool("echo"));
    const { url, cleanup } = await startHttpMcpServer(usable);

    await cleanup();

    try {
      await fetch(url, { signal: AbortSignal.timeout(500) });
      expect.unreachable("Server should be shut down");
    } catch {
      // Expected: connection refused or timeout
    }
  });
});
