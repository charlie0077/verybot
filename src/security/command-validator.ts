/**
 * Command validation for bash tool security.
 *
 * Blocks dangerous shell syntax (quote-aware) and checks executables
 * against safe-bin and allowlist rules.
 */

/** Shell tokens blocked outside of quotes. */
const BLOCKED_CHARS = new Set(["`", ">", "<", "(", ")"]);

/** Default read-only commands that always pass in allowlist mode. */
export const DEFAULT_SAFE_BINS = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "grep",
  "rg",
  "find",
  "wc",
  "sort",
  "uniq",
  "cut",
  "tr",
  "jq",
  "date",
  "whoami",
  "pwd",
  "echo",
  "which",
  "file",
  "stat",
  "du",
  "df",
  "uname",
  "env",
  "printenv",
  "ps",
  "curl",
  "wget",
]);

interface ValidationResult {
  ok: boolean;
  reason?: string;
}

/**
 * Check for dangerous shell syntax (quote-aware).
 *
 * Blocks backticks, command substitution `$(...)`, redirects `> <`,
 * and subshells `( )` when they appear outside of quotes.
 */
export function validateCommand(command: string): ValidationResult {
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    // Track quote state
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }

    // Skip chars inside quotes
    if (inSingle || inDouble) continue;

    // Check for $( command substitution
    if (ch === "$" && i + 1 < command.length && command[i + 1] === "(") {
      return { ok: false, reason: "command substitution $(...) is not allowed" };
    }

    if (BLOCKED_CHARS.has(ch)) {
      const names: Record<string, string> = {
        "`": "backtick execution",
        ">": "output redirect",
        "<": "input redirect",
        "(": "subshell",
        ")": "subshell",
      };
      return { ok: false, reason: `${names[ch] ?? ch} is not allowed` };
    }
  }

  return { ok: true };
}

/**
 * Extract the executable name from a command string.
 * Handles env-prefix patterns like `VAR=val cmd` and paths like `/usr/bin/python3`.
 */
function extractExecutable(segment: string): string {
  const trimmed = segment.trim();
  const tokens = trimmed.split(/\s+/);

  // Skip leading env assignments (KEY=VALUE)
  let idx = 0;
  while (idx < tokens.length && /^[A-Za-z_]\w*=/.test(tokens[idx])) {
    idx++;
  }

  const raw = tokens[idx] ?? "";
  // Strip path: /usr/bin/python3 -> python3
  const slashIdx = raw.lastIndexOf("/");
  return slashIdx >= 0 ? raw.slice(slashIdx + 1) : raw;
}

/** Split a command into segments on `&&`, `||`, `;`, and `|`. */
function splitSegments(command: string): string[] {
  // Split on && || ; | while respecting quotes
  const segments: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
      continue;
    }

    if (inSingle || inDouble) {
      current += ch;
      continue;
    }

    // Check for && or ||
    if ((ch === "&" || ch === "|") && i + 1 < command.length && command[i + 1] === ch) {
      segments.push(current);
      current = "";
      i++; // skip second char
      continue;
    }

    // Check for ; or single |
    if (ch === ";" || ch === "|") {
      segments.push(current);
      current = "";
      continue;
    }

    current += ch;
  }

  if (current.trim()) segments.push(current);
  return segments.filter((s) => s.trim().length > 0);
}

/** Check if ALL segments of a command use only safe bins. */
function isSafeBin(command: string, safeBins: Set<string>): boolean {
  const segments = splitSegments(command);
  return segments.every((seg) => safeBins.has(extractExecutable(seg)));
}

/** Convert a simple glob pattern to a RegExp (`*` -> `.*`). */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/** Check if an executable matches any allowlist glob pattern. */
function matchesAllowlist(executable: string, patterns: string[]): boolean {
  return patterns.some((pat) => globToRegExp(pat).test(executable));
}

/** Check if ALL segments of a command match the allowlist. */
export function isAllowed(command: string, safeBins: Set<string>, allowlist: string[]): boolean {
  const segments = splitSegments(command);
  return segments.every((seg) => {
    const exe = extractExecutable(seg);
    return safeBins.has(exe) || matchesAllowlist(exe, allowlist);
  });
}
