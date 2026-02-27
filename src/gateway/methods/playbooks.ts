import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { emit } from "../../events.js";
import { PLAYBOOK_DIR, PLAYBOOKS_DIR } from "../../paths.js";

const INDEX_FILENAME = "index.yaml";
const README_FILENAME = "README.md";
const SCRIPTS_DIRNAME = "scripts";
const DEFAULT_README = "# New Playbook\n\n## When to use\n- TODO\n\n## Steps\n- TODO\n";
const PLAYBOOK_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9 _-]{0,63}$/;

interface PlaybookIndexEntry {
  name: string;
  description: string;
  triggers: string[];
  tags: string[];
}

interface PlaybookDiskInfo {
  readmeExists: boolean;
  readme: string;
  scriptFiles: string[];
  scriptCodeFiles: PlaybookScriptCodeFile[];
}

interface PlaybookScriptCodeFile {
  path: string;
  content: string;
}

function normalizeScriptPath(rawPath: unknown): string | null {
  if (typeof rawPath !== "string") return null;
  const normalized = rawPath.trim().replace(/\\/g, "/");
  if (!normalized) return null;
  if (normalized.startsWith("/")) return null;

  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0) return null;
  if (segments.some((segment) => segment === "." || segment === "..")) return null;

  return segments.join("/");
}

function normalizeScriptCodeFiles(value: unknown): PlaybookScriptCodeFile[] {
  if (!Array.isArray(value)) return [];

  const files: PlaybookScriptCodeFile[] = [];
  const seenPaths = new Set<string>();

  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const candidate = item as { path?: unknown; content?: unknown };
    const path = normalizeScriptPath(candidate.path);
    if (!path || seenPaths.has(path)) continue;

    const content = typeof candidate.content === "string" ? candidate.content : "";
    files.push({ path, content });
    seenPaths.add(path);
  }

  return files;
}

function getIndexPath(): string {
  return join(PLAYBOOK_DIR, INDEX_FILENAME);
}

function sanitizePlaybookName(rawName: unknown): string {
  if (typeof rawName !== "string") throw new Error("playbook name is required");
  const trimmed = rawName.trim();
  const sanitized = basename(trimmed);
  if (!sanitized || sanitized === "." || sanitized === "..") {
    throw new Error("Invalid playbook name");
  }
  if (!PLAYBOOK_NAME_PATTERN.test(sanitized)) {
    throw new Error("Playbook name must be alphanumeric (spaces/hyphens/underscores allowed, max 64 chars)");
  }
  return sanitized;
}

function resolvePlaybookDir(name: string): string {
  const target = resolve(PLAYBOOKS_DIR, name);
  const parent = resolve(PLAYBOOKS_DIR);
  if (!target.startsWith(`${parent}/`)) {
    throw new Error("Invalid playbook path");
  }
  return target;
}

function isNonEmptyArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length > 0;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

function parseYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";

  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed
      .slice(1, -1)
      .replace(/\\n/g, "\n")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }

  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }

  return trimmed;
}

function parseInlineYamlList(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return [];
  const body = trimmed.slice(1, -1).trim();
  if (!body) return [];

  return body
    .split(",")
    .map((item) => parseYamlScalar(item))
    .map((item) => item.trim())
    .filter(Boolean);
}

function lineIndent(line: string): number {
  return line.length - line.trimStart().length;
}

function parseYamlBlockList(lines: string[], startIndex: number, parentIndent: number): {
  values: string[];
  nextIndex: number;
} {
  const values: string[] = [];
  let idx = startIndex;

  while (idx < lines.length) {
    const line = lines[idx];
    if (!line.trim()) {
      idx++;
      continue;
    }

    const indent = lineIndent(line);
    if (indent <= parentIndent) break;

    const itemMatch = line.match(/^\s*-\s*(.*)$/);
    if (!itemMatch) break;

    const parsed = parseYamlScalar(itemMatch[1]);
    if (parsed) values.push(parsed);
    idx++;
  }

  return { values, nextIndex: idx };
}

function parseIndexYaml(raw: string): PlaybookIndexEntry[] {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const entries: PlaybookIndexEntry[] = [];
  let idx = 0;

  while (idx < lines.length) {
    const line = lines[idx];
    const nameMatch = line.match(/^\s*-\s*name:\s*(.*)$/);
    if (!nameMatch) {
      idx++;
      continue;
    }

    const name = parseYamlScalar(nameMatch[1]);
    const entry: PlaybookIndexEntry = {
      name,
      description: "",
      triggers: [],
      tags: [],
    };

    idx++;

    while (idx < lines.length) {
      const current = lines[idx];

      if (/^\s*-\s*name:\s*/.test(current)) break;

      const descriptionMatch = current.match(/^\s*description:\s*(.*)$/);
      if (descriptionMatch) {
        entry.description = parseYamlScalar(descriptionMatch[1]);
        idx++;
        continue;
      }

      const triggersMatch = current.match(/^\s*triggers:\s*(.*)$/);
      if (triggersMatch) {
        const inline = triggersMatch[1].trim();
        if (inline) {
          entry.triggers = parseInlineYamlList(inline);
          idx++;
          continue;
        }

        const parsed = parseYamlBlockList(lines, idx + 1, lineIndent(current));
        entry.triggers = parsed.values;
        idx = parsed.nextIndex;
        continue;
      }

      const tagsMatch = current.match(/^\s*tags:\s*(.*)$/);
      if (tagsMatch) {
        const inline = tagsMatch[1].trim();
        if (inline) {
          entry.tags = parseInlineYamlList(inline);
          idx++;
          continue;
        }

        const parsed = parseYamlBlockList(lines, idx + 1, lineIndent(current));
        entry.tags = parsed.values;
        idx = parsed.nextIndex;
        continue;
      }

      idx++;
    }

    if (entry.name) {
      entries.push({
        name: entry.name,
        description: entry.description,
        triggers: normalizeStringArray(entry.triggers),
        tags: normalizeStringArray(entry.tags),
      });
    }
  }

  return entries;
}

function yamlEscape(value: string): string {
  if (/[:\n\r#"'\[\]{}|>&*!%@`]/.test(value) || value.trim() !== value) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
  }
  return value;
}

function serializeIndexYaml(entries: PlaybookIndexEntry[]): string {
  if (entries.length === 0) return "playbooks: []\n";

  const lines = ["playbooks:"];

  for (const entry of entries) {
    lines.push(`  - name: ${yamlEscape(entry.name)}`);
    lines.push(`    description: ${yamlEscape(entry.description)}`);

    if (isNonEmptyArray(entry.triggers)) {
      lines.push("    triggers:");
      for (const trigger of entry.triggers) {
        lines.push(`      - ${yamlEscape(trigger)}`);
      }
    } else {
      lines.push("    triggers: []");
    }

    if (isNonEmptyArray(entry.tags)) {
      lines.push("    tags:");
      for (const tag of entry.tags) {
        lines.push(`      - ${yamlEscape(tag)}`);
      }
    } else {
      lines.push("    tags: []");
    }
  }

  return `${lines.join("\n")}\n`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readIndexEntries(): Promise<PlaybookIndexEntry[]> {
  const indexPath = getIndexPath();
  const raw = await readFile(indexPath, "utf-8").catch(() => "");
  if (!raw.trim()) return [];
  return parseIndexYaml(raw);
}

async function writeIndexEntries(entries: PlaybookIndexEntry[]): Promise<void> {
  await mkdir(PLAYBOOK_DIR, { recursive: true });
  const indexPath = getIndexPath();
  await writeFile(indexPath, serializeIndexYaml(entries), "utf-8");
}

async function listFilesRecursive(root: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const abs = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const relPath = relative(root, abs).replace(/\\/g, "/");
      files.push(relPath);
    }
  }

  if (await exists(root)) {
    await walk(root);
  }

  return files.sort((a, b) => a.localeCompare(b));
}

async function readDiskPlaybook(name: string): Promise<PlaybookDiskInfo | null> {
  const dir = resolvePlaybookDir(name);
  if (!(await exists(dir))) return null;

  const readmePath = join(dir, README_FILENAME);
  const scriptsDir = join(dir, SCRIPTS_DIRNAME);
  const readmeExists = await exists(readmePath);
  const readme = readmeExists ? await readFile(readmePath, "utf-8") : "";
  const scriptFiles = await listFilesRecursive(scriptsDir);
  const scriptCodeFiles = await Promise.all(
    scriptFiles.map(async (path) => {
      const content = await readFile(join(scriptsDir, path), "utf-8").catch(() => "");
      return { path, content };
    }),
  );

  return { readmeExists, readme, scriptFiles, scriptCodeFiles };
}

function findIndexEntry(entries: PlaybookIndexEntry[], name: string): PlaybookIndexEntry | undefined {
  return entries.find((entry) => entry.name === name);
}

function normalizeIndexEntry(params: {
  name: string;
  description?: unknown;
  triggers?: unknown;
  tags?: unknown;
}): PlaybookIndexEntry {
  return {
    name: params.name,
    description: typeof params.description === "string" ? params.description.trim() : "",
    triggers: normalizeStringArray(params.triggers),
    tags: normalizeStringArray(params.tags),
  };
}

async function listDiskPlaybookNames(): Promise<string[]> {
  const entries = await readdir(PLAYBOOKS_DIR, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

export function playbookMethods() {
  return {
    "playbooks.list": async () => {
      const indexEntries = await readIndexEntries();
      const indexMap = new Map(indexEntries.map((entry) => [entry.name, entry]));
      const diskNames = await listDiskPlaybookNames();
      const names = new Set<string>([...indexMap.keys(), ...diskNames]);
      const sortedNames = Array.from(names).sort((a, b) => a.localeCompare(b));

      const playbooks = await Promise.all(
        sortedNames.map(async (name) => {
          const indexEntry = indexMap.get(name);
          const diskEntry = await readDiskPlaybook(name);

          return {
            name,
            description: indexEntry?.description ?? "",
            triggers: indexEntry?.triggers ?? [],
            tags: indexEntry?.tags ?? [],
            inIndex: Boolean(indexEntry),
            onDisk: Boolean(diskEntry),
            readmeExists: diskEntry?.readmeExists ?? false,
            scriptCount: diskEntry?.scriptFiles.length ?? 0,
          };
        }),
      );

      return { playbooks };
    },

    "playbooks.get": async (params: unknown) => {
      const payload = (params ?? {}) as { name?: unknown };
      const name = sanitizePlaybookName(payload.name);

      const indexEntries = await readIndexEntries();
      const indexEntry = findIndexEntry(indexEntries, name);
      const diskEntry = await readDiskPlaybook(name);

      if (!indexEntry && !diskEntry) {
        throw new Error(`Playbook not found: ${name}`);
      }

      return {
        playbook: {
          name,
          description: indexEntry?.description ?? "",
          triggers: indexEntry?.triggers ?? [],
          tags: indexEntry?.tags ?? [],
          inIndex: Boolean(indexEntry),
          onDisk: Boolean(diskEntry),
          readmeExists: diskEntry?.readmeExists ?? false,
          readme: diskEntry?.readme ?? "",
          scriptFiles: diskEntry?.scriptFiles ?? [],
          scriptCodeFiles: diskEntry?.scriptCodeFiles ?? [],
        },
      };
    },

    "playbooks.create": async (params: unknown) => {
      const payload = (params ?? {}) as {
        name?: unknown;
        description?: unknown;
        triggers?: unknown;
        tags?: unknown;
        readme?: unknown;
      };
      const name = sanitizePlaybookName(payload.name);
      const readme = typeof payload.readme === "string" ? payload.readme : DEFAULT_README;

      const indexEntries = await readIndexEntries();
      if (findIndexEntry(indexEntries, name)) {
        throw new Error(`Playbook already exists in index: ${name}`);
      }

      const playbookDir = resolvePlaybookDir(name);
      if (await exists(playbookDir)) {
        throw new Error(`Playbook directory already exists: ${name}`);
      }

      const normalized = normalizeIndexEntry({
        name,
        description: payload.description,
        triggers: payload.triggers,
        tags: payload.tags,
      });

      const nextEntries = [...indexEntries, normalized].sort((a, b) => a.name.localeCompare(b.name));

      await mkdir(playbookDir, { recursive: true });
      await mkdir(join(playbookDir, SCRIPTS_DIRNAME), { recursive: true });
      await writeFile(join(playbookDir, README_FILENAME), readme, "utf-8");
      await writeIndexEntries(nextEntries);

      emit("playbookChange", { action: "created", name });
      return { status: "ok" };
    },

    "playbooks.update": async (params: unknown) => {
      const payload = (params ?? {}) as {
        name?: unknown;
        description?: unknown;
        triggers?: unknown;
        tags?: unknown;
        readme?: unknown;
        scriptCodeFiles?: unknown;
      };
      const name = sanitizePlaybookName(payload.name);
      const hasReadme = typeof payload.readme === "string";
      const readme = hasReadme ? (payload.readme as string) : null;
      const scriptCodeFiles = normalizeScriptCodeFiles(payload.scriptCodeFiles);

      const indexEntries = await readIndexEntries();
      const normalized = normalizeIndexEntry({
        name,
        description: payload.description,
        triggers: payload.triggers,
        tags: payload.tags,
      });

      const existingIndex = findIndexEntry(indexEntries, name);
      const nextEntries = existingIndex
        ? indexEntries.map((entry) => (entry.name === name ? normalized : entry))
        : [...indexEntries, normalized].sort((a, b) => a.name.localeCompare(b.name));

      const playbookDir = resolvePlaybookDir(name);
      await mkdir(playbookDir, { recursive: true });
      const scriptsDir = join(playbookDir, SCRIPTS_DIRNAME);
      await mkdir(scriptsDir, { recursive: true });
      const readmePath = join(playbookDir, README_FILENAME);
      if (readme !== null) {
        await writeFile(readmePath, readme, "utf-8");
      } else if (!(await exists(readmePath))) {
        await writeFile(readmePath, DEFAULT_README, "utf-8");
      }

      for (const scriptFile of scriptCodeFiles) {
        const targetScriptPath = resolve(scriptsDir, scriptFile.path);
        if (!targetScriptPath.startsWith(`${resolve(scriptsDir)}/`)) {
          throw new Error(`Invalid script path: ${scriptFile.path}`);
        }
        await mkdir(dirname(targetScriptPath), { recursive: true });
        await writeFile(targetScriptPath, scriptFile.content, "utf-8");
      }

      await writeIndexEntries(nextEntries);

      emit("playbookChange", { action: "updated", name });
      return { status: "ok" };
    },

    "playbooks.rename": async (params: unknown) => {
      const payload = (params ?? {}) as { name?: unknown; newName?: unknown };
      const name = sanitizePlaybookName(payload.name);
      const newName = sanitizePlaybookName(payload.newName);

      if (name === newName) return { status: "ok" };

      const indexEntries = await readIndexEntries();
      const oldEntry = findIndexEntry(indexEntries, name);
      const newEntry = findIndexEntry(indexEntries, newName);
      if (newEntry) throw new Error(`Playbook already exists: ${newName}`);

      const oldDir = resolvePlaybookDir(name);
      const newDir = resolvePlaybookDir(newName);
      const oldDirExists = await exists(oldDir);
      const newDirExists = await exists(newDir);

      if (!oldEntry && !oldDirExists) {
        throw new Error(`Playbook not found: ${name}`);
      }
      if (newDirExists) {
        throw new Error(`Playbook directory already exists: ${newName}`);
      }

      if (oldDirExists) {
        await mkdir(PLAYBOOKS_DIR, { recursive: true });
        await rename(oldDir, newDir);
      }

      const nextEntries = oldEntry
        ? indexEntries
          .map((entry) => (entry.name === name ? { ...entry, name: newName } : entry))
          .sort((a, b) => a.name.localeCompare(b.name))
        : [...indexEntries, { name: newName, description: "", triggers: [], tags: [] }]
          .sort((a, b) => a.name.localeCompare(b.name));

      await writeIndexEntries(nextEntries);

      emit("playbookChange", { action: "renamed", name, newName });
      return { status: "ok" };
    },

    "playbooks.delete": async (params: unknown) => {
      const payload = (params ?? {}) as { name?: unknown };
      const name = sanitizePlaybookName(payload.name);

      const indexEntries = await readIndexEntries();
      const nextEntries = indexEntries.filter((entry) => entry.name !== name);
      const hadIndexEntry = nextEntries.length !== indexEntries.length;

      const playbookDir = resolvePlaybookDir(name);
      const hadDirectory = await exists(playbookDir);

      if (!hadIndexEntry && !hadDirectory) {
        throw new Error(`Playbook not found: ${name}`);
      }

      if (hadDirectory) {
        await rm(playbookDir, { recursive: true, force: true });
      }
      await writeIndexEntries(nextEntries);

      emit("playbookChange", { action: "deleted", name });
      return { status: "ok" };
    },
  };
}
