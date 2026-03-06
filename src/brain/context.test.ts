import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "./context.js";
import { PLAYBOOK_DIR } from "../paths.js";

describe("buildSystemPrompt", () => {
  it("injects team workspace and variables when provided", () => {
    const prompt = buildSystemPrompt({
      identity: "You are an assistant.",
      modelId: "gpt-5.3-codex",
      language: "English",
      teamWorkspace: "/workspace/repo",
      teamVariables: { project: "verybot", env: "prod" },
    });

    expect(prompt).toContain("## Team Context");
    expect(prompt).toContain("Workspace: /workspace/repo");
    expect(prompt).toContain("- project: verybot");
    expect(prompt).toContain("- env: prod");
  });

  it("omits team context section when workspace and variables are empty", () => {
    const prompt = buildSystemPrompt({
      identity: "You are an assistant.",
      modelId: "gpt-5.3-codex",
      language: "English",
    });

    expect(prompt).not.toContain("## Team Context");
  });

  it("includes playbook guidance with the configured root path", () => {
    const prompt = buildSystemPrompt({
      identity: "You are an assistant.",
      modelId: "gpt-5.3-codex",
      language: "English",
    });

    expect(prompt).toContain("## Playbooks");
    expect(prompt).toContain(PLAYBOOK_DIR);
    expect(prompt).toContain("do not create a `memory/` folder");
    expect(prompt).toContain("also save/update those script files under `playbooks/<name>/scripts/`");
    expect(prompt).toContain("also save a concise memory fact in SQLite");
    expect(prompt).toContain("playbook path(s) updated");
  });

  it("includes subscribed task guidance when task context is provided", () => {
    const prompt = buildSystemPrompt({
      identity: "You are an assistant.",
      modelId: "gpt-5.3-codex",
      language: "English",
      subscribedTask: {
        id: "4",
        teamId: "frontend",
        title: "Fix codexcli reasoning label display",
        currentStatus: "todo",
        currentStatusLabel: "Todo",
        availableStatuses: [
          { key: "backlog", label: "Backlog" },
          { key: "todo", label: "Todo" },
          { key: "in_progress", label: "In Progress" },
          { key: "done", label: "Done" },
        ],
      },
    });

    expect(prompt).toContain("## Subscribed Task Mode");
    expect(prompt).toContain("non-interactive worker run");
    expect(prompt).toContain("- id: 4");
    expect(prompt).toContain("- team: frontend");
    expect(prompt).toContain('- current status: todo ("Todo")');
    expect(prompt).toContain("Available statuses (use the key when calling tools):");
    expect(prompt).toContain('backlog ("Backlog"), todo ("Todo"), in_progress ("In Progress"), done ("Done")');
    expect(prompt).toContain("Quick Question Blocks");
    expect(prompt).toContain("```question");
    expect(prompt).toContain("title: Decision title");
    expect(prompt).toContain("Use `type: multi` for multi-select.");
    expect(prompt).not.toContain("task_update");
    expect(prompt).not.toContain("task_get");
  });

  it("includes quick question guidance for interactive sessions", () => {
    const prompt = buildSystemPrompt({
      identity: "You are an assistant.",
      modelId: "gpt-5.3-codex",
      language: "English",
    });

    expect(prompt).toContain("## Clarification Questions");
    expect(prompt).toContain("```question");
    expect(prompt).toContain("title: Decision title");
    expect(prompt).toContain("Never output plain numbered multiple-choice text");
  });

  it("uses text-first voice guidance for tts-capable sessions", () => {
    const prompt = buildSystemPrompt({
      identity: "You are an assistant.",
      modelId: "gpt-5.3-codex",
      language: "English",
      hasTTS: true,
      channelType: "gateway",
    });

    expect(prompt).toContain("Voice: default to text.");
    expect(prompt).toContain("explicitly asks for audio/read-aloud");
    expect(prompt).not.toContain("prefer speak for short replies");
  });

  it("keeps delegation guidance generic and on-demand", () => {
    const prompt = buildSystemPrompt({
      identity: "You are an assistant.",
      modelId: "gpt-5.3-codex",
      language: "English",
      hasDelegation: true,
    });

    expect(prompt).toContain("## Delegation");
    expect(prompt).toContain("Use list_workers to discover available worker names");
    expect(prompt).not.toContain("Workers run in background. Available:");
  });
});
