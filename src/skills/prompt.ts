import type { SkillEntry } from "./types.js";

/**
 * Build a compact system prompt section listing available skills.
 * The model uses `read_skill` to fetch full content on demand.
 */
export function buildSkillListing(skills: SkillEntry[]): string {
  if (skills.length === 0) return "";

  const lines = skills.map(
    (s) => `  - **${s.name}**: ${s.description || "(no description)"}`,
  );

  return `## Available Skills
You have access to specialized skills. Use the \`read_skill\` tool to read the full instructions for a skill before applying it.

<available_skills>
${lines.join("\n")}
</available_skills>

When a user's request matches a skill, read it first, then follow its instructions.`;
}
