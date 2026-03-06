import type { BashSecurityMode } from "../config.js";
import { PLAYBOOK_DIR } from "../paths.js";

export interface SubscribedTaskContext {
  id: string;
  teamId: string;
  title: string;
  currentStatus: string;
  currentStatusLabel?: string;
  availableStatuses: { key: string; label: string }[];
  /** Consensus mode for this status: "none" (single-agent, no consensus) or "unanimous" (multi-agent vote). */
  consensusMode?: "none" | "unanimous";
}

export interface ContextInput {
  identity: string;
  /** Model identifier shown to the model so it can self-identify (e.g. "claude-3.5-sonnet"). */
  modelId?: string;
  /** Team workspace path injected for team-scoped sessions. */
  teamWorkspace?: string;
  /** Team custom variables injected for team-scoped sessions. */
  teamVariables?: Record<string, string>;
  language?: string;
  skillPrompts?: string[];
  skillListing?: string;
  /** Compact listing of all available integrations (always shown). */
  integrationListing?: string;
  /** System prompts for currently active integrations only. */
  activeIntegrationPrompts?: string[];
  hasMemory?: boolean;
  bashMode?: BashSecurityMode;
  bashSafeBins?: string[];
  hasDesktop?: boolean;
  /** Whether schedule tools are available. */
  hasScheduler?: boolean;
  /** Whether this is a scheduled task execution (not a user conversation). */
  scheduledTask?: boolean;
  /** Whether this session is the team's shared scheduler session. */
  schedulerSession?: boolean;
  /** Whether TTS speak tool is available. */
  hasTTS?: boolean;
  /** Channel type for this session (e.g. "telegram", "gateway"). */
  channelType?: string;
  /** Whether delegation tools are available for this run. */
  hasDelegation?: boolean;
  /** Claimed task context for pull-based subscription workers. */
  subscribedTask?: SubscribedTaskContext;
}

export function buildSystemPrompt(input: ContextInput): string {
  const parts: string[] = [];

  // Language directive
  if (input.language === "auto" || !input.language) {
    parts.push(
      `Reply in the user's language (default: English). Internal reasoning in English.`
    );
  } else if (input.language !== "English") {
    parts.push(
      `Reply in ${input.language}. Internal reasoning in English.`
    );
  }

  parts.push(input.identity);

  if (input.modelId) {
    parts.push(`You are powered by the ${input.modelId} model.`);
  }

  parts.push(`Current time: ${new Date().toISOString()}`);

  const teamContext = buildTeamContextSection(input.teamWorkspace, input.teamVariables);
  if (teamContext) {
    parts.push(teamContext);
  }

  parts.push(buildPlaybookSection());

  // Compact tool strategy — only cross-tool orchestration that can't live in individual tool descriptions
  const strategy: string[] = [];
  strategy.push(`Web: try web_fetch first → browser tools if blocked/JS-heavy. Never give up without trying browser.`);
  if (input.hasTTS) {
    strategy.push(`Voice: default to text. Use speak only when the user explicitly asks for audio/read-aloud.`);
  }
  if (input.hasDesktop) {
    strategy.push(`Desktop: screenshot → act → screenshot → verify.`);
  }
  parts.push(`## Tools\n${strategy.map((s) => `- ${s}`).join("\n")}`);
  if (!input.scheduledTask) {
    parts.push(buildQuickQuestionGuidanceSection());
  }

  if (input.subscribedTask) {
    parts.push(buildSubscribedTaskSection(input.subscribedTask));
  }

  // Bash — only allowlist mode needs extra context (safe bins list)
  if (input.bashMode === "allowlist") {
    const bins = input.bashSafeBins?.join(", ") ?? "";
    parts.push(
      `## Bash\nAllowlist mode. Safe commands: ${bins}. If blocked, suggest an allowed alternative.`,
    );
  }

  if (input.skillPrompts?.length) {
    for (const prompt of input.skillPrompts) {
      parts.push(prompt);
    }
  }

  if (input.skillListing) {
    parts.push(input.skillListing);
  }

  if (input.integrationListing) {
    parts.push(input.integrationListing);
  }

  if (input.activeIntegrationPrompts?.length) {
    for (const prompt of input.activeIntegrationPrompts) {
      parts.push(prompt);
    }
  }

  // Delegation — keep orchestration guidance, but keep worker discovery on-demand.
  if (input.hasDelegation) {
    parts.push(
      `## Delegation
Workers run in background.
Use list_workers to discover available worker names when needed.
Delegate → get channel ID → notified on completion → read_channel for results.
Workers have no conversation context — include everything they need in the task.`,
    );
  }

  // Scheduler session guidance
  if (input.schedulerSession) {
    parts.push(
      `## Scheduler Session
Shared session. [Scheduled Task] = automated. [User via ...] = human. [Scheduler Result | ...] = compacted history.`,
    );
  }

  // Scheduled task execution mode (non-interactive)
  if (input.scheduledTask) {
    parts.push(
      `## Scheduled Task Mode
Automated task — execute immediately, do not ask questions.
Reminders: deliver directly. Data tasks: fetch and present.
Conditional: reply with [SKIP] + reason if nothing noteworthy.
Keep replies concise — this is a notification.`,
    );
  }

  return parts.join("\n\n");
}

function buildPlaybookSection(): string {
  return `## Playbooks
Filesystem playbooks are stored at: ${PLAYBOOK_DIR}
Use playbooks for reusable workflows:
- Check \`index.yaml\` for triggers/tags, then open the relevant \`playbooks/<name>/README.md\`.
- Follow README "When to use" and "Steps" sections before ad-hoc approaches.
- Keep workflow-specific scripts in \`playbooks/<name>/scripts/\`; use \`scripts/shared/\` only for cross-playbook scripts.
- Use file tools (\`read\`/\`write\`/\`edit\`) directly on paths under ${PLAYBOOK_DIR} when the user asks to update playbooks.
- Long-term memory lives in the DB, so do not create a \`memory/\` folder in playbooks.
- Only update playbook files when the user explicitly asks to save/update playbook content.
- If the requested playbook update includes scripts, also save/update those script files under \`playbooks/<name>/scripts/\` (not just \`README.md\`).
- After an explicit playbook update, also save a concise memory fact in SQLite (use memory save tooling) that includes:
  - playbook path(s) updated (for example, \`~/.verybot/playbook/playbooks/<name>/README.md\`)
  - what changed (README, scripts, index)
  - a short purpose/trigger summary.`;
}

function buildQuickQuestionGuidanceSection(): string {
  return `## Clarification Questions
When your response includes selectable choices (clarification, quiz, poll, or "multiple choice questions"), you MUST use Quick Question Blocks so the UI can render clickable choices.
Required format:
\`\`\`question
title: Decision title
options:
  - Option A
  - Option B
\`\`\`
Use \`type: multi\` for multi-select. Keep options concise and mutually clear.
Never output plain numbered multiple-choice text like \`1. ... A) ... B) ...\`.
Never label options as \`A)\`, \`B)\`, \`C)\`, etc.
If you are about to ask a choice question, output only \`\`\`question\`\`\` blocks for those choices.`; 
}

function buildSubscribedTaskSection(task: SubscribedTaskContext): string {
  const availableStatuses = task.availableStatuses.length > 0
    ? task.availableStatuses.map((s) => s.label !== s.key ? `${s.key} ("${s.label}")` : s.key).join(", ")
    : "(none)";
  const currentStatusDisplay = task.currentStatusLabel && task.currentStatusLabel !== task.currentStatus
    ? `${task.currentStatus} ("${task.currentStatusLabel}")`
    : task.currentStatus;
  const consensusInstructions = task.consensusMode === "unanimous"
    ? `\n\nThis status uses UNANIMOUS consensus. Multiple agents work on this task simultaneously.
Use task_vote to submit your recommended next status when done.
You may also use task_update to change status — it will record your vote and check consensus automatically.`
    : "";
  return `## Subscribed Task Mode
You are executing a claimed task in a non-interactive worker run.
Claimed task:
- id: ${task.id}
- team: ${task.teamId}
- title: ${task.title}
- current status: ${currentStatusDisplay}
Available statuses (use the key when calling tools):
- ${availableStatuses}${consensusInstructions}`;
}

function buildTeamContextSection(
  workspace?: string,
  variables?: Record<string, string>,
): string | null {
  const normalizedWorkspace = workspace?.trim() ?? "";
  const variableLines = Object.entries(variables ?? {});
  if (!normalizedWorkspace && variableLines.length === 0) return null;

  const workspaceLine = normalizedWorkspace || "(not set)";
  const variablesBlock = variableLines.length > 0
    ? variableLines.map(([key, value]) => `- ${key}: ${value}`).join("\n")
    : "- (none)";

  return `## Team Context
Workspace: ${workspaceLine}
Variables:
${variablesBlock}`;
}
