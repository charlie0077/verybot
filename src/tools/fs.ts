import { tool, type Tool } from "ai";
import { z } from "zod";
import { readFile, writeFile, mkdir, readdir } from "fs/promises";
import { execSync } from "child_process";
import { dirname, resolve } from "path";
import { sanitizeEnv } from "../security/env-filter.js";
import { logger } from "../logger.js";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const MAX_OUTPUT = 10_000;
const DEFAULT_LINE_LIMIT = 2_000;
const DEFAULT_SEARCH_LIMIT = 200;
const EXEC_TIMEOUT = 15_000;

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function sliceLines(text: string, offset: number, limit: number): string {
  const lines = text.split("\n");
  const start = Math.max(0, offset);
  const end = Math.min(lines.length, start + limit);
  return lines
    .slice(start, end)
    .map((line, i) => `${start + i + 1}\t${line}`)
    .join("\n");
}

function truncate(text: string, max = MAX_OUTPUT): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "\n…[truncated]";
}

/** Truncate output to N lines (for limiting search results in JS). */
function truncateLines(text: string, maxLines: number): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return lines.slice(0, maxLines).join("\n") + "\n…[truncated]";
}

let rgAvailable: boolean | null = null;
function isRipgrepAvailable(): boolean {
  if (rgAvailable === null) {
    try {
      execSync("rg --version", { stdio: "ignore", timeout: 3_000 });
      rgAvailable = true;
    } catch {
      rgAvailable = false;
    }
  }
  return rgAvailable;
}

function shellEscape(arg: string): string {
  if (arg.includes("\0")) {
    throw new Error("Null bytes not allowed in shell arguments");
  }
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/* ------------------------------------------------------------------ */
/*  Tools                                                              */
/* ------------------------------------------------------------------ */

const readTool: Tool = tool({
  description:
    "Read a file from the filesystem. Returns numbered lines. " +
    "Use offset/limit for large files.",
  inputSchema: z.object({
    path: z.string().describe("Absolute or relative file path"),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("0-based line offset to start reading from"),
    limit: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Max number of lines to return"),
  }),
  execute: async ({ path, offset, limit }) => {
    try {
      const content = await readFile(resolve(path), "utf-8");
      const lineOffset = offset ?? 0;
      const lineLimit = limit ?? DEFAULT_LINE_LIMIT;
      return truncate(sliceLines(content, lineOffset, lineLimit));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`read failed: ${msg}`);
      return `Error: ${msg}`;
    }
  },
});

const writeTool: Tool = tool({
  description:
    "Write content to a file. Creates parent directories if needed. " +
    "Overwrites existing files.",
  inputSchema: z.object({
    path: z.string().describe("Absolute or relative file path"),
    content: z.string().describe("File content to write"),
  }),
  execute: async ({ path, content }) => {
    try {
      const resolved = resolve(path);
      await mkdir(dirname(resolved), { recursive: true });
      await writeFile(resolved, content, "utf-8");
      return `Wrote ${content.split("\n").length} lines to ${resolved}`;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`write failed: ${msg}`);
      return `Error: ${msg}`;
    }
  },
});

const editTool: Tool = tool({
  description:
    "Edit a file by replacing an exact text match. " +
    "oldText must appear exactly once in the file.",
  inputSchema: z.object({
    path: z.string().describe("Absolute or relative file path"),
    oldText: z.string().min(1).describe("Exact text to find (must be unique in file)"),
    newText: z.string().describe("Replacement text"),
  }),
  execute: async ({ path, oldText, newText }) => {
    try {
      const resolved = resolve(path);
      const content = await readFile(resolved, "utf-8");

      const occurrences = content.split(oldText).length - 1;
      if (occurrences === 0) {
        return "Error: oldText not found in file";
      }
      if (occurrences > 1) {
        return `Error: oldText found ${occurrences} times — must be unique. Provide more surrounding context.`;
      }

      // Use function replacement to avoid special pattern interpretation ($&, $`, etc.)
      const updated = content.replace(oldText, () => newText);
      await writeFile(resolved, updated, "utf-8");
      return `Edited ${resolved} — replaced 1 occurrence`;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`edit failed: ${msg}`);
      return `Error: ${msg}`;
    }
  },
});

const grepTool: Tool = tool({
  description:
    "Search file contents using ripgrep (rg) or grep. " +
    "Returns matching lines with file paths and line numbers.",
  inputSchema: z.object({
    pattern: z.string().describe("Search pattern (regex unless literal=true)"),
    path: z
      .string()
      .optional()
      .describe("Directory or file to search (default: cwd)"),
    glob: z
      .string()
      .optional()
      .describe("File glob filter, e.g. '*.ts'"),
    ignoreCase: z
      .boolean()
      .optional()
      .describe("Case-insensitive search"),
    literal: z
      .boolean()
      .optional()
      .describe("Treat pattern as literal string, not regex"),
    context: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Lines of context around each match"),
    limit: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Max number of result lines to return"),
  }),
  execute: async ({ pattern, path, glob: fileGlob, ignoreCase, literal, context, limit }) => {
    const searchPath = resolve(path ?? ".");
    const maxLines = limit ?? DEFAULT_SEARCH_LIMIT;

    try {
      let cmd: string;

      if (isRipgrepAvailable()) {
        const args = ["rg", "--no-heading", "-n"];
        if (ignoreCase) args.push("-i");
        if (literal) args.push("-F");
        if (context) args.push("-C", String(context));
        if (fileGlob) args.push("--glob", fileGlob);
        args.push("--", pattern, searchPath);
        cmd = args.map(shellEscape).join(" ");
      } else {
        const args = ["grep", "-rn"];
        if (ignoreCase) args.push("-i");
        if (literal) args.push("-F");
        if (context) args.push("-C", String(context));
        if (fileGlob) args.push("--include", fileGlob);
        args.push("--", pattern, searchPath);
        cmd = args.map(shellEscape).join(" ");
      }

      const output = execSync(cmd, {
        encoding: "utf-8",
        timeout: EXEC_TIMEOUT,
        maxBuffer: 2 * 1024 * 1024,
        env: sanitizeEnv(),
      });

      return truncate(truncateLines(output || "No matches found", maxLines));
    } catch (err: unknown) {
      // grep/rg exit code 1 = no matches (not an error)
      const code = (err as { status?: number }).status;
      if (code === 1) return "No matches found";

      const stderr = (err as { stderr?: string }).stderr ?? "";
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`grep failed: ${msg}`);
      return `Error: ${stderr || msg}`.slice(0, MAX_OUTPUT);
    }
  },
});

const findTool: Tool = tool({
  description:
    "Find files by name pattern. Uses the system `find` command. " +
    "Returns matching file paths.",
  inputSchema: z.object({
    pattern: z
      .string()
      .describe("Filename glob pattern, e.g. '*.ts' or 'index.*'"),
    path: z
      .string()
      .optional()
      .describe("Directory to search in (default: cwd)"),
    limit: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Max number of results"),
  }),
  execute: async ({ pattern, path, limit }) => {
    const searchPath = resolve(path ?? ".");
    const maxResults = limit ?? DEFAULT_SEARCH_LIMIT;

    try {
      const cmd = [
        "find",
        shellEscape(searchPath),
        "-name",
        shellEscape(pattern),
        "-not",
        "-path",
        shellEscape("*/node_modules/*"),
        "-not",
        "-path",
        shellEscape("*/.git/*"),
      ].join(" ");

      const output = execSync(cmd, {
        encoding: "utf-8",
        timeout: EXEC_TIMEOUT,
        maxBuffer: 2 * 1024 * 1024,
        env: sanitizeEnv(),
      });

      return truncate(truncateLines(output || "No files found", maxResults));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`find failed: ${msg}`);
      return `Error: ${msg}`.slice(0, MAX_OUTPUT);
    }
  },
});

const lsTool: Tool = tool({
  description:
    "List directory contents with type indicators. " +
    "Directories end with /, symlinks with @.",
  inputSchema: z.object({
    path: z
      .string()
      .optional()
      .describe("Directory to list (default: cwd)"),
    limit: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Max number of entries to return"),
  }),
  execute: async ({ path, limit }) => {
    const dirPath = resolve(path ?? ".");
    const maxEntries = limit ?? DEFAULT_SEARCH_LIMIT;

    try {
      const entries = await readdir(dirPath, { withFileTypes: true });
      const lines = entries.slice(0, maxEntries).map((entry) => {
        if (entry.isDirectory()) return `${entry.name}/`;
        if (entry.isSymbolicLink()) return `${entry.name}@`;
        return entry.name;
      });

      if (entries.length > maxEntries) {
        lines.push(`…and ${entries.length - maxEntries} more`);
      }

      return lines.join("\n") || "(empty directory)";
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`ls failed: ${msg}`);
      return `Error: ${msg}`;
    }
  },
});

/* ------------------------------------------------------------------ */
/*  Export                                                             */
/* ------------------------------------------------------------------ */

const SANDBOX_ERROR =
  "Error: This tool is disabled in sandbox mode. Use bash instead (cat, tee, grep, find, ls).";

function sandboxGuard(t: Tool): Tool {
  return { ...t, execute: async () => SANDBOX_ERROR };
}

export function createFsTools(opts?: { sandboxed?: boolean }): Record<string, Tool> {
  const wrap = opts?.sandboxed ? sandboxGuard : (t: Tool) => t;

  return {
    read: wrap(readTool),
    write: wrap(writeTool),
    edit: wrap(editTool),
    grep: wrap(grepTool),
    find: wrap(findTool),
    ls: wrap(lsTool),
  };
}
