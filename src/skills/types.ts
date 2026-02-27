/** Metadata parsed from a SKILL.md frontmatter during startup scan. */
export interface SkillEntry {
  /** Skill name (from frontmatter `name` or directory name) */
  name: string;
  /** One-line description (from frontmatter `description`) */
  description: string;
  /** Full raw content of SKILL.md (cached for read_skill tool) */
  content: string;
  /** Optional list of tool names this skill references */
  tools: string[];
  /** Optional Lucide icon name */
  icon?: string;
  /** Absolute path to the SKILL.md file */
  path: string;
}
