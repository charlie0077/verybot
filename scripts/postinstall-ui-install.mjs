import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const UI_PACKAGE_JSON_RELATIVE_PATH = "ui/package.json";

/**
 * Always install UI dependencies through npm from the repository root postinstall.
 * This keeps dependency setup consistent and avoids requiring bun in install hooks.
 */
function runUiInstall() {
  const uiPackageJsonPath = resolve(process.cwd(), UI_PACKAGE_JSON_RELATIVE_PATH);
  if (!existsSync(uiPackageJsonPath)) {
    return;
  }

  const result = spawnSync("npm", ["--prefix", "ui", "install"], {
    stdio: "inherit",
    env: process.env,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

runUiInstall();
