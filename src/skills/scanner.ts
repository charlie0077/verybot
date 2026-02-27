import { readdir, readFile, stat } from "fs/promises";
import { join, basename, resolve } from "path";
import type { SkillEntry } from "./types.js";
import { logger } from "../logger.js";

const SKILL_FILENAME = "SKILL.md";

/** Parse optional YAML frontmatter delimited by --- */
function parseFrontmatter(raw: string): { meta: Record<string, unknown>; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw };

  const meta: Record<string, unknown> = {};
  for (const line of match[1].split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let value: unknown = line.slice(colon + 1).trim();
    // Handle inline YAML list: tools: [a, b, c]
    if (typeof value === "string" && value.startsWith("[") && value.endsWith("]")) {
      value = value
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
    meta[key] = value;
  }
  return { meta, body: match[2] };
}

/**
 * Scan `dir` for subdirectories containing SKILL.md files.
 * Returns metadata for each discovered skill.
 */
export async function scanSkills(dir: string): Promise<SkillEntry[]> {
  const absDir = resolve(dir);
  let entries: string[];
  try {
    entries = await readdir(absDir);
  } catch {
    logger.info(`Skills directory not found: ${absDir} (skipping)`);
    return [];
  }

  const skills: SkillEntry[] = [];
  const seenNames = new Set<string>();

  for (const entry of entries) {
    const entryPath = join(absDir, entry);
    const entryStat = await stat(entryPath).catch(() => null);
    if (!entryStat?.isDirectory()) continue;

    const skillFile = join(entryPath, SKILL_FILENAME);
    let raw: string;
    try {
      raw = await readFile(skillFile, "utf-8");
    } catch {
      continue; // no SKILL.md in this directory
    }

    const { meta, body } = parseFrontmatter(raw);
    const name = (meta.name as string) ?? basename(entryPath);
    const description = (meta.description as string) ?? "";
    const tools = Array.isArray(meta.tools) ? (meta.tools as string[]) : [];
    const icon = (meta.icon as string) ?? undefined;

    const normalizedName = name.toLowerCase();
    if (seenNames.has(normalizedName)) {
      logger.warn(`Duplicate skill name "${name}" at ${skillFile}, skipping`);
      continue;
    }
    seenNames.add(normalizedName);

    skills.push({ name, description, content: body, tools, icon, path: skillFile });
    // logger.info(`Loaded skill: ${name}${description ? ` — ${description}` : ""}`);
  }

  return skills;
}
