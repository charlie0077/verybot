import { join } from "path";
import { homedir } from "os";
import { mkdirSync } from "fs";

/** Root data directory: ~/.verybot */
export const BASE_DIR = join(homedir(), ".verybot");

/** Conversation history (JSONL files): ~/.verybot/sessions/ */
export const SESSIONS_DIR = join(BASE_DIR, "sessions");

/** Long-term memory + schedules (SQLite): ~/.verybot/memory.db */
export const MEMORY_DB_PATH = join(BASE_DIR, "memory.db");
/** Global command aliases file: ~/.verybot/command-aliases.json */
export const COMMAND_ALIASES_PATH = join(BASE_DIR, "command-aliases.json");

/** Chromium user data: ~/.verybot/browser/ */
export const BROWSER_PROFILE_DIR = join(BASE_DIR, "browser");

/** Named browser profiles: ~/.verybot/browser-profiles/ */
export const BROWSER_PROFILES_DIR = join(BASE_DIR, "browser-profiles");

/** User skill definitions: ~/.verybot/skills/ */
export const SKILLS_DIR = join(BASE_DIR, "skills");

/** User integration definitions: ~/.verybot/integrations/ */
export const INTEGRATIONS_DIR = join(BASE_DIR, "integrations");

/** Playbook root: ~/.verybot/playbook */
export const PLAYBOOK_DIR = join(BASE_DIR, "playbook");
/** Playbook folders: ~/.verybot/playbook/playbooks */
export const PLAYBOOKS_DIR = join(PLAYBOOK_DIR, "playbooks");

/** Docker sandbox workspace: ~/.verybot/workspace/ */
export const SANDBOX_WORKSPACE = join(BASE_DIR, "workspace");

/** WhatsApp Baileys auth state: ~/.verybot/whatsapp-auth/ */
export const WHATSAPP_AUTH_DIR = join(BASE_DIR, "whatsapp-auth");

/** Task image attachments: ~/.verybot/attachments/ */
export const ATTACHMENTS_DIR = join(BASE_DIR, "attachments");

/** All directories that should exist at startup. */
const REQUIRED_DIRS = [
  BASE_DIR,
  SESSIONS_DIR,
  BROWSER_PROFILE_DIR,
  BROWSER_PROFILES_DIR,
  SKILLS_DIR,
  INTEGRATIONS_DIR,
  PLAYBOOK_DIR,
  PLAYBOOKS_DIR,
  WHATSAPP_AUTH_DIR,
  ATTACHMENTS_DIR,
];

/** Ensure all data directories exist. Call once at startup. */
export function ensureDirs(): void {
  for (const dir of REQUIRED_DIRS) {
    mkdirSync(dir, { recursive: true });
  }
}
