# VeryBot Advanced Reference

This page keeps technical/runtime details out of the main README.

## CLI

| Command | Purpose |
| --- | --- |
| `node verybot.js --version` | Show current version |
| `node verybot.js --host <host> --port <port>` | Override runtime bind host/port without editing config |
| `node verybot.js config get` | Print redacted config |
| `node verybot.js config get <key>` | Read one key |
| `node verybot.js config set <key> <value>` | Update one key |
| `node verybot.js config regenerate_gateway_token` | Generate a new gateway token |
| `node verybot.js claude-login` | Run `claude setup-token` and store OAuth token |

Examples:

```bash
node verybot.js config get model
node verybot.js config set model openai:gpt-5
node verybot.js config set browserHeadless false
node verybot.js config set bash.security allowlist
node verybot.js --host 127.0.0.1 --port 28789
```

## Key Configuration Options

Main source of truth is `~/.verybot/config.json` (usually edited via UI Settings).

| Key | Example | Notes |
| --- | --- | --- |
| `model` | `openai:gpt-5` | Provider + model id |
| `maxSteps` | `20` | Max tool/model steps per run |
| `browserMode` | `per-tab-per-session` | `shared`, `per-tab-per-session`, `per-browser-per-session` |
| `browserHeadless` | `false` | Show/hide browser UI |
| `bash.security` | `allowlist` | `deny`, `allowlist`, `full` |
| `memory.enabled` | `true` | Toggle long-term memory |
| `mcpServers` | `{...}` | MCP server registry |

## Browser Isolation Modes

- `shared`: one context shared across all sessions.
- `per-tab-per-session`: shared browser with session tab isolation.
- `per-browser-per-session`: dedicated browser context per session.

## Built-in Tools

- Web fetch and extraction
- Filesystem read/write/list
- Shell execution (security modes)
- Browser actions (`navigate`, `snapshot`, `click`, `type`, `screenshot`, `press_key`)
- Team/task/scheduler CRUD workflows
- Memory save/search helpers

## Runtime Data Directory

VeryBot stores runtime state under `~/.verybot`:

| Path | Purpose |
| --- | --- |
| `config.json` | Runtime config + secrets |
| `memory.db` | Tasks, teams, scheduler, memory, templates |
| `sessions/` | Conversation history (JSONL) |
| `browser/` | Default browser user data |
| `browser-profiles/` | Named browser profiles |
| `skills/` | User skills (`SKILL.md`) |
| `integrations/` | Integration definitions |
| `playbook/` | Reusable playbooks |
| `whatsapp-auth/` | WhatsApp auth state |
| `attachments/` | Task attachments |
| `workspace/` | Docker sandbox workspace (if enabled) |

## Troubleshooting

- UI cannot connect:
  - Ensure runtime is running.
  - Confirm backend API is reachable at `http://localhost:28789`.
- Token/auth failure:
  - Print token with `node verybot.js config get GATEWAY_TOKEN`.
  - Regenerate token if needed: `node verybot.js config regenerate_gateway_token`.
- Browser automation fails:
  - Install browsers/deps: `npx playwright install`.
- Channel messages not arriving:
  - Recheck channel credentials in Settings.
  - Check runtime logs.

## Security Notes

- Bash tool supports `deny`, `allowlist`, and `full` modes.
- Optional Docker sandbox can isolate untrusted command execution.
- Sensitive config values are redacted in UI-facing responses.

## Tech Stack

- Runtime: TypeScript (ESM), Node.js 22+
- AI: Vercel AI SDK provider ecosystem
- Database: SQLite (`better-sqlite3`) + `sqlite-vec`
- Browser automation: Playwright
- UI: React 19 + React Router v7 + Tailwind v4 + shadcn/ui
- Tests: Vitest
