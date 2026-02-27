import { spawnSync } from "node:child_process";

/**
 * Always install UI dependencies through npm from the repository root postinstall.
 * This keeps dependency setup consistent and avoids requiring bun in install hooks.
 */
function runUiInstall() {
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
