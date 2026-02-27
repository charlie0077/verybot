import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const PKG_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "package.json");

/** Lazily-cached package version string. */
let cached: string | undefined;

export function getVersion(): string {
  if (!cached) {
    const pkg = JSON.parse(readFileSync(PKG_PATH, "utf-8"));
    cached = pkg.version as string;
  }
  return cached;
}
