// ---------------------------------------------------------------------------
// Structured command result — channels format parts with their own escaping
// ---------------------------------------------------------------------------

/** A segment of a command response that needs channel-specific formatting. */
export type CommandPart = string | { bold: string } | { code: string };

export interface CommandResult {
  parts: CommandPart[];
}

const LEARN_COMMAND = "/learn";
const REMEMBER_COMMAND = "/remember";
const REMEMBER_USAGE = `${REMEMBER_COMMAND} <fact>`;

// ---------------------------------------------------------------------------
// CommandRouter — shared /clear, /reset, /team, /learn logic
// ---------------------------------------------------------------------------

export interface CommandRouterOpts {
  onClear?: (channelType: string, channelId: string, teamId?: string) => Promise<void>;
  onLearn?: (
    channelType: string,
    channelId: string,
    topic?: string,
    teamId?: string,
  ) => Promise<{
    topic?: string;
    extracted: number;
    saved: number;
    skipped: number;
    savedFacts: string[];
  }>;
  onRemember?: (
    channelType: string,
    channelId: string,
    fact: string,
    teamId?: string,
  ) => Promise<{ saved: boolean; fact: string }>;
  /** List available teams for the /team command. */
  listTeams?: () => { id: string; name: string }[];
  /** Fallback team when no active team is set for a channel. */
  defaultTeamId?: string;
}

export class CommandRouter {
  private readonly activeTeams = new Map<string, string>();

  constructor(private readonly opts: CommandRouterOpts) {}

  /** Resolve the active team for a channel, falling back to configured defaultTeamId. */
  resolveTeamId(channelId: string): string | undefined {
    return this.activeTeams.get(channelId) ?? this.opts.defaultTeamId;
  }

  /**
   * Parse raw text for slash-style commands (e.g. "/clear", "/team foo").
   * Returns `null` if the text is not a recognised command.
   */
  async handle(channelType: string, channelId: string, text: string): Promise<CommandResult | null> {
    const trimmed = text.trim();
    const lower = trimmed.toLowerCase();

    if (lower === "/clear" || lower === "/reset") {
      return this.handleClear(channelType, channelId);
    }

    if ((lower === "/team" || lower.startsWith("/team ")) && this.opts.listTeams) {
      const arg = trimmed.slice("/team".length).trim();
      return this.handleTeam(channelType, channelId, arg);
    }

    if (this.opts.onLearn) {
      if (lower === LEARN_COMMAND || lower.startsWith(`${LEARN_COMMAND} `)) {
        const topic = trimmed.slice(LEARN_COMMAND.length).trim();
        return this.handleLearn(channelType, channelId, topic || undefined);
      }
    }

    if (this.opts.onRemember) {
      if (lower === REMEMBER_COMMAND || lower.startsWith(`${REMEMBER_COMMAND} `)) {
        const fact = trimmed.slice(REMEMBER_COMMAND.length).trim();
        return this.handleRemember(channelType, channelId, fact);
      }
    }

    return null;
  }

  /** Handle /clear (or /reset). */
  async handleClear(channelType: string, channelId: string): Promise<CommandResult> {
    if (this.opts.onClear) {
      await this.opts.onClear(channelType, channelId, this.resolveTeamId(channelId));
    }
    return { parts: ["Session cleared."] };
  }

  /** Handle /team [name]. */
  async handleTeam(channelType: string, channelId: string, arg: string): Promise<CommandResult> {
    const teams = this.opts.listTeams?.() ?? [];

    // No argument → list teams with the active one highlighted.
    if (!arg) {
      const currentTeamId = this.resolveTeamId(channelId);
      const parts: CommandPart[] = ["Teams:\n"];
      for (const t of teams) {
        if (t.id === currentTeamId) {
          parts.push("• ", { bold: t.name }, " (active)\n");
        } else {
          parts.push("• ", t.name, "\n");
        }
      }
      parts.push("\nSwitch with ", { code: "/team <name>" });
      return { parts };
    }

    // Find team by name (case-insensitive).
    const target = teams.find((t) => t.name.toLowerCase() === arg.toLowerCase());
    if (!target) {
      return {
        parts: ['Unknown team "', arg, '". Use ', { code: "/team" }, " to list available teams."],
      };
    }

    this.activeTeams.set(channelId, target.id);
    return {
      parts: ["Switched to team ", { bold: target.name }, "."],
    };
  }

  /** Handle /learn [topic]. */
  async handleLearn(channelType: string, channelId: string, topic?: string): Promise<CommandResult> {
    if (!this.opts.onLearn) {
      return { parts: ["Memory is not enabled"] };
    }
    let result:
      | {
        topic?: string;
        extracted: number;
        saved: number;
        skipped: number;
        savedFacts: string[];
      };
    try {
      result = await this.opts.onLearn(
        channelType,
        channelId,
        topic,
        this.resolveTeamId(channelId),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to save memory";
      return { parts: [msg] };
    }

    if (result.extracted === 0) {
      return result.topic
        ? { parts: ['No learnable facts found about "', result.topic, '" in the current session.'] }
        : { parts: ["No learnable facts found in the current session."] };
    }

    const topicSuffix = result.topic ? ` about "${result.topic}"` : "";
    const summary =
      result.saved > 0
        ? `Learned ${result.saved} ${pluralize("fact", result.saved)}${topicSuffix}.`
        : `Found ${result.extracted} ${pluralize("fact", result.extracted)}${topicSuffix}, but all were already known.`;

    if (result.savedFacts.length === 0) {
      return { parts: [summary] };
    }

    const factLines = result.savedFacts.map((fact) => `• ${fact}`).join("\n");
    return { parts: [`${summary}\n${factLines}`] };
  }

  /** Handle /remember [fact]. */
  async handleRemember(channelType: string, channelId: string, fact: string): Promise<CommandResult> {
    if (!this.opts.onRemember) {
      return { parts: ["Memory is not enabled"] };
    }
    if (!fact) {
      return { parts: ["Usage: ", { code: REMEMBER_USAGE }] };
    }

    try {
      const result = await this.opts.onRemember(
        channelType,
        channelId,
        fact,
        this.resolveTeamId(channelId),
      );
      return result.saved
        ? { parts: ['Learned: "', result.fact, '"'] }
        : { parts: ['Already known: "', result.fact, '"'] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to save memory";
      return { parts: [msg] };
    }
  }
}

function pluralize(word: string, count: number): string {
  return count === 1 ? word : `${word}s`;
}
