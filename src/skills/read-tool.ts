import { tool, type Tool } from "ai";
import { z } from "zod";
import type { SkillEntry } from "./types.js";

/**
 * Create the read_skill tool with the given skill entries baked in.
 * Returns the full SKILL.md content for the requested skill name.
 */
export function createReadSkillTool(skills: SkillEntry[]): Tool {
  const skillMap = new Map(skills.map((s) => [s.name.toLowerCase(), s]));
  const validNames = skills.map((s) => s.name).join(", ");

  return tool({
    description:
      `Read the full instructions for a skill. Available: ${validNames}. ` +
      `Call this before applying a skill so you know its full instructions.`,
    inputSchema: z.object({
      name: z.string().describe("The skill name to read"),
    }),
    execute: async ({ name }) => {
      const entry = skillMap.get(name.toLowerCase());
      if (!entry) {
        return `Unknown skill "${name}". Available: ${validNames}`;
      }
      return entry.content;
    },
  });
}
