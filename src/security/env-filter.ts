/**
 * Environment variable filtering for bash tool security.
 *
 * Strips dangerous env vars that could be used for code injection
 * (LD_PRELOAD, DYLD_*, NODE_OPTIONS, etc.) before passing to child processes.
 */

/** Exact env var names to strip (from Verybot's DANGEROUS_HOST_ENV_VARS). */
const BLOCKED_VARS = new Set([
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PYTHONPATH",
  "PYTHONHOME",
  "RUBYLIB",
  "PERL5LIB",
  "BASH_ENV",
  "ENV",
  "GCONV_PATH",
  "IFS",
  "SSLKEYLOGFILE",
]);

/** Env var prefixes to strip (catches all DYLD_* and LD_* variants). */
const BLOCKED_PREFIXES = ["DYLD_", "LD_"];

/** Returns a copy of process.env with dangerous variables removed. */
export function sanitizeEnv(): Record<string, string> {
  const clean: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (BLOCKED_VARS.has(key)) continue;
    if (BLOCKED_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    clean[key] = value;
  }

  return clean;
}
