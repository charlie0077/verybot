import fs from "node:fs";
import path from "node:path";
import type { ModelMessage } from "ai";
import { Session } from "./session.js";
import { parseSessionKey } from "./session-key.js";

const MAX_TITLE_LEN = 30;

/** JSONL entry: either a message or a compaction marker. */
interface MessageEntry {
  ts: number;
  message: ModelMessage;
}

interface CompactionEntry {
  type: "compaction";
  ts: number;
  summary: string;
}

type JournalEntry = MessageEntry | CompactionEntry;

function isCompaction(entry: JournalEntry): entry is CompactionEntry {
  return "type" in entry && entry.type === "compaction";
}

export interface SessionIndexEntry {
  key: string;
  file: string;
  messageCount: number;
  updatedAt: number;
  /** Human-readable title — auto-set from first user message, editable via rename. */
  title?: string;
  /** Team UUID (stable reference, survives renames). */
  teamId?: string;
  /** Team name snapshot at save time (denormalized for fast display). */
  teamName?: string;
  /** Channel type: "gateway", "worker", "scheduler", "telegram", etc. */
  channelType?: string;
  /** Worker agent ID (stable reference for worker sessions). */
  agentId?: string;
  /** Worker agent name snapshot at save time (denormalized for display). */
  agentName?: string;
}

export class SessionStore {
  private dataDir: string;
  private indexPath: string;
  private index: Map<string, SessionIndexEntry>;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.indexPath = path.join(dataDir, "index.json");

    // Ensure directory exists
    fs.mkdirSync(dataDir, { recursive: true });

    // Load existing index
    this.index = this.loadIndex();
  }

  /** Save session to JSONL. Three modes: compaction marker, full rewrite, or append. */
  async save(session: Session): Promise<void> {
    const entry = this.getOrCreateEntry(session.key);
    const filePath = path.join(this.dataDir, entry.file);

    if (session.pendingCompaction) {
      // Compaction: append marker + re-append kept messages (append-only, preserves history)
      const marker: CompactionEntry = {
        type: "compaction",
        ts: Date.now(),
        summary: session.pendingCompaction.summary,
      };
      const kept = session.getCompactionMessages();
      const lines =
        JSON.stringify(marker) +
        "\n" +
        kept.map((msg) => JSON.stringify({ ts: Date.now(), message: msg })).join("\n") +
        "\n";
      fs.appendFileSync(filePath, lines, "utf-8");
    } else if (session.needsFullRewrite) {
      // Emergency truncate: overwrite entire file
      const all = session.getMessages();
      const lines =
        all.map((msg) => JSON.stringify({ ts: Date.now(), message: msg })).join("\n") + "\n";
      fs.writeFileSync(filePath, lines, "utf-8");
    } else {
      // Normal: append only new messages
      const newMessages = session.getNewMessages();
      if (newMessages.length === 0) return;
      const lines =
        newMessages.map((msg) => JSON.stringify({ ts: Date.now(), message: msg })).join("\n") + "\n";
      fs.appendFileSync(filePath, lines, "utf-8");
    }

    session.markPersisted();

    // Update index
    entry.messageCount = session.messageCount;
    entry.updatedAt = Date.now();

    // Auto-set title from first user message (once)
    if (!entry.title) {
      const firstUserMsg = session
        .getMessages()
        .find((m) => m.role === "user" && typeof m.content === "string" && m.content.trim());
      if (firstUserMsg && typeof firstUserMsg.content === "string") {
        const raw = firstUserMsg.content.trim().split("\n")[0];
        entry.title = raw.length > MAX_TITLE_LEN ? raw.slice(0, MAX_TITLE_LEN - 1) + "\u2026" : raw;
      }
    }

    this.saveIndex();
  }

  /** Load a session from its JSONL file. Respects compaction markers. */
  async load(sessionKey: string): Promise<Session | null> {
    const entry = this.index.get(sessionKey);
    if (!entry) return null;

    const filePath = path.join(this.dataDir, entry.file);
    if (!fs.existsSync(filePath)) return null;

    const content = fs.readFileSync(filePath, "utf-8");
    const entries: JournalEntry[] = [];

    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        // skip malformed lines
      }
    }

    // Find the last compaction marker
    let lastCompactionIdx = -1;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (isCompaction(entries[i])) {
        lastCompactionIdx = i;
        break;
      }
    }

    const messages: ModelMessage[] = [];

    if (lastCompactionIdx >= 0) {
      // Compacted: summary message + all message entries after the marker
      const marker = entries[lastCompactionIdx] as CompactionEntry;
      messages.push({
        role: "user",
        content: `[Prior conversation summary]\n${marker.summary}`,
      });
      for (let i = lastCompactionIdx + 1; i < entries.length; i++) {
        const e = entries[i];
        if (!isCompaction(e)) {
          messages.push(e.message);
        }
      }
    } else {
      // No compaction: load all messages
      for (const e of entries) {
        if (!isCompaction(e)) {
          messages.push(e.message);
        }
      }
    }

    return new Session(sessionKey, messages);
  }

  /** List all session keys with metadata. */
  list(): SessionIndexEntry[] {
    return [...this.index.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Rename a session (update its title in the index). */
  rename(sessionKey: string, title: string): boolean {
    if (typeof title !== "string") return false;
    const entry = this.index.get(sessionKey);
    if (!entry) return false;
    // Strip control characters and trim
    const sanitized = title.replace(/[\x00-\x1F\x7F-\x9F]/g, "").trim();
    if (sanitized.length === 0) return false;
    entry.title = sanitized.length > MAX_TITLE_LEN ? sanitized.slice(0, MAX_TITLE_LEN - 1) + "\u2026" : sanitized;
    this.saveIndex();
    return true;
  }

  /**
   * Update session metadata (team name, agent info). Only writes to disk if something changed.
   * Note: teamName and agentName are denormalized snapshots — they may become stale if
   * the team or agent is renamed after the session was last active.
   */
  updateMetadata(sessionKey: string, meta: {
    teamId?: string;
    teamName?: string;
    channelType?: string;
    agentId?: string;
    agentName?: string;
  }): void {
    const entry = this.index.get(sessionKey);
    if (!entry) return;
    const FIELDS = ["teamId", "teamName", "channelType", "agentId", "agentName"] as const;
    let changed = false;
    for (const field of FIELDS) {
      if (meta[field] !== undefined && entry[field] !== meta[field]) {
        entry[field] = meta[field];
        changed = true;
      }
    }
    if (changed) this.saveIndex();
  }

  /** Clear a session — deletes the JSONL file and removes the index entry. */
  async clear(sessionKey: string): Promise<void> {
    const entry = this.index.get(sessionKey);
    if (!entry) return;

    const filePath = path.join(this.dataDir, entry.file);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    this.index.delete(sessionKey);
    this.saveIndex();
  }


  // --- internal ---

  private getOrCreateEntry(key: string): SessionIndexEntry {
    let entry = this.index.get(key);
    if (!entry) {
      const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, "_");
      const parsed = parseSessionKey(key);
      entry = {
        key,
        file: `${safeKey}.jsonl`,
        messageCount: 0,
        updatedAt: Date.now(),
        teamId: parsed.teamId,
        channelType: parsed.channelType,
      };
      this.index.set(key, entry);
    }
    return entry;
  }

  private loadIndex(): Map<string, SessionIndexEntry> {
    if (!fs.existsSync(this.indexPath)) {
      return new Map();
    }
    try {
      const raw = JSON.parse(fs.readFileSync(this.indexPath, "utf-8"));
      return new Map(Object.entries(raw));
    } catch {
      return new Map();
    }
  }

  private saveIndex(): void {
    const obj = Object.fromEntries(this.index);
    fs.writeFileSync(this.indexPath, JSON.stringify(obj, null, 2), "utf-8");
  }
}
