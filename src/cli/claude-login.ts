import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { ConfigStore } from "../config/store.js";
import { BASE_DIR } from "../paths.js";

/** Prompt the user for a single line of input. */
function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Run `claude setup-token` interactively, then ask the user to paste
 * the resulting token and save it to config.json.
 */
export async function handleClaudeLogin(): Promise<void> {
  console.log("Running `claude setup-token`...\n");

  const result = spawnSync("claude", ["setup-token"], {
    stdio: "inherit",
    encoding: "utf-8",
  });

  if (result.error) {
    console.error(
      "Failed to run `claude setup-token`. Is the Claude Code CLI installed?\n" +
        "Install it with: npm install -g @anthropic-ai/claude-code",
    );
    process.exitCode = 1;
    return;
  }

  if (result.status !== 0) {
    console.error(`\nclaude setup-token exited with code ${result.status}`);
    process.exitCode = 1;
    return;
  }

  console.log("");
  const token = await prompt("Paste the token (sk-ant-oat01-...): ");

  if (!token.startsWith("sk-ant-")) {
    console.error("Invalid token — expected it to start with sk-ant-");
    process.exitCode = 1;
    return;
  }

  const store = new ConfigStore(BASE_DIR);
  store.patch({ CLAUDE_CODE_OAUTH_TOKEN: token });

  console.log("\n✓ Token saved to config.json");
  console.log("  Restart the gateway to use it.");
}
