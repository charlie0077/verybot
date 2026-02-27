import { tool } from "ai";
import { z } from "zod";
import { Octokit } from "octokit";
import type { Integration } from "./types.js";
import { logger } from "../logger.js";

const MAX_ISSUES_PER_PAGE = 30;

interface GithubConfig {
  token: string;
  defaultOwner?: string;
}

/** Zod schema for GitHub integration config. */
const githubConfigSchema = z.object({
  token: z.string().min(1),
  defaultOwner: z.string().optional(),
});

/** Flat config.json keys → GithubConfig fields. */
const GITHUB_CONFIG_KEYS: Record<string, string> = {
  token: "GITHUB_TOKEN",
  defaultOwner: "GITHUB_DEFAULT_OWNER",
};

export function createGithubIntegration(config: GithubConfig): Integration {
  const octokit = new Octokit({ auth: config.token });

  const tools = {
    github_create_issue: tool({
      description: "Create a new GitHub issue in a repository",
      inputSchema: z.object({
        owner: z.string().describe("Repository owner (user or org)"),
        repo: z.string().describe("Repository name"),
        title: z.string().describe("Issue title"),
        body: z.string().optional().describe("Issue body (markdown)"),
        labels: z.array(z.string()).optional().describe("Labels to apply"),
      }),
      execute: async ({ owner, repo, title, body, labels }) => {
        try {
          const { data } = await octokit.rest.issues.create({
            owner: owner ?? config.defaultOwner ?? "",
            repo,
            title,
            body,
            labels,
          });
          return `Created issue #${data.number}: ${data.html_url}`;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error(`github_create_issue failed: ${msg}`);
          return `Error creating issue: ${msg}`;
        }
      },
    }),

    github_list_issues: tool({
      description: "List issues in a GitHub repository",
      inputSchema: z.object({
        owner: z.string().describe("Repository owner (user or org)"),
        repo: z.string().describe("Repository name"),
        state: z.enum(["open", "closed", "all"]).optional().describe("Filter by state (default: open)"),
        labels: z.string().optional().describe("Comma-separated label names to filter by"),
        limit: z
          .number()
          .optional()
          .describe(`Max issues to return (default: ${MAX_ISSUES_PER_PAGE})`),
      }),
      execute: async ({ owner, repo, state, labels, limit }) => {
        try {
          const { data } = await octokit.rest.issues.listForRepo({
            owner: owner ?? config.defaultOwner ?? "",
            repo,
            state: state ?? "open",
            labels,
            per_page: Math.min(limit ?? MAX_ISSUES_PER_PAGE, 100),
          });
          if (data.length === 0) return "No issues found.";
          return data
            .map((i) => `#${i.number} [${i.state}] ${i.title} — ${i.html_url}`)
            .join("\n");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error(`github_list_issues failed: ${msg}`);
          return `Error listing issues: ${msg}`;
        }
      },
    }),

    github_create_pr: tool({
      description: "Create a pull request in a GitHub repository",
      inputSchema: z.object({
        owner: z.string().describe("Repository owner (user or org)"),
        repo: z.string().describe("Repository name"),
        title: z.string().describe("PR title"),
        body: z.string().optional().describe("PR description (markdown)"),
        head: z.string().describe("Branch containing changes"),
        base: z.string().describe("Branch to merge into (e.g., 'main')"),
      }),
      execute: async ({ owner, repo, title, body, head, base }) => {
        try {
          const { data } = await octokit.rest.pulls.create({
            owner: owner ?? config.defaultOwner ?? "",
            repo,
            title,
            body,
            head,
            base,
          });
          return `Created PR #${data.number}: ${data.html_url}`;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error(`github_create_pr failed: ${msg}`);
          return `Error creating PR: ${msg}`;
        }
      },
    }),
  };

  return {
    id: "github",
    name: "github",
    source: "builtin",
    tools: {
      tools,
      systemPrompt: [
        "## GitHub Integration",
        "You have GitHub tools available:",
        "- `github_create_issue`: Create a new issue in a repo",
        "- `github_list_issues`: List issues in a repo",
        "- `github_create_pr`: Create a pull request",
      ].join("\n"),
      initialize: async () => {
        const { data } = await octokit.rest.users.getAuthenticated();
        logger.info(`GitHub integration ready (authenticated as ${data.login})`);
      },
    },
    config: {
      schema: githubConfigSchema,
      configKeys: GITHUB_CONFIG_KEYS,
    },
  };
}
