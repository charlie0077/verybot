# VeryBot - Assistant for Your Work

<p align="center">
  <strong>One assistant for your work across chat, tasks, teams, playbooks, and channels.</strong>
</p>

<p align="center">
  <a href="https://opensource.org/license/mit"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
  <a href="https://github.com/charlie0077/verybot"><img src="https://img.shields.io/github/stars/charlie0077/verybot?style=for-the-badge" alt="GitHub stars"></a>
</p>

VeryBot is a self-hosted AI assistant platform for real work.  
It helps individuals, teams, and developers run work from one place: chat with your assistant, organize tasks, manage teams, save playbooks, automate recurring jobs, and connect external channels like Telegram, Discord, Slack, and WhatsApp.

[Quick Start (User)](#quick-start-user) · [Quick Start (Developer)](#quick-start-developer) · [Let LLM Set Up Your Flow Example](#let-llm-set-up-your-flow-example) · [Playbooks](#playbooks) · [Docs](#docs)

## Why VeryBot

- Reduce context-switching: one assistant across chat, tasks, teams, and channels.
- Turn talk into execution: convert conversations into structured tasks you can track and ship.
- Move faster with less micromanagement: set goals once and let the assistant create/follow up on work.
- Replace repetitive reminders with scheduled automation.
- Stay in control anywhere: use the same Control UI from desktop or mobile when reachable.
- Reuse what works: save proven workflows as playbooks and run them again.
- Keep your data ownership: self-host with local-first runtime data under `~/.verybot`.
- Extend only when needed: add tools, skills, and MCP integrations without changing core workflow.

## Who It Is For

- Solo operators: personal work copilot with task and reminder automation.
- Small teams: shared team context, team-specific workflows, and worker agents.
- Developers: self-hosted runtime with tools, APIs, and extensibility.

## Quick Start (User)

Requirements:

- Node.js `>=22`
- npm

Install and run (npm, fastest):

```bash
npm install -g verybot
verybot
```

Upgrade later:

```bash
npm install -g verybot@latest
```

Open the Control UI:

- `http://localhost:28789`

If the UI asks for a gateway token, you can:

- Copy it from the terminal output where you started `verybot` (`GATEWAY_TOKEN: ...`)
- Or run:

```bash
verybot config get GATEWAY_TOKEN
```

First setup in **Settings -> Agent**:

1. Choose a model provider.
2. If you picked an API-key provider, add your API key.
3. If you use Codex CLI or Claude CLI and it already works on this machine, no API key setup is needed.
4. Save and send a chat prompt like: `Set up a team and starter tasks for launch planning.`

Need to access it from LAN or internet?

### LAN access

From installed CLI runtime (bind gateway/UI on all interfaces):

```bash
verybot --host 0.0.0.0 --port 28789
```

Then open:

- `http://<your-lan-ip>:28789`

### Internet access (recommended setup)

1. Run VeryBot on the server:

```bash
verybot --host 127.0.0.1 --port 28789
```

2. Put a reverse proxy with TLS in front (example: Caddy):

```caddy
verybot.example.com {
  reverse_proxy 127.0.0.1:28789
}
```

3. Point your domain DNS to that server and open only ports `80/443` in firewall/security groups.
4. Keep `GATEWAY_TOKEN` private and rotate it if leaked.

## Quick Start (Developer)

Clone and run from source:

```bash
git clone https://github.com/charlie0077/verybot.git
cd verybot
npm install
npm run dev
```

Useful commands:

| Command | Purpose |
| --- | --- |
| `npm run dev` | Backend + UI dev servers |
| `npm run dev:backend` | Backend only (`tsx watch`) |
| `npm run dev:lan` | Expose UI on LAN (`0.0.0.0:10000`) |
| `npm run build` | Build backend + UI to `dist/` |
| `npm start` | Run production build |
| `npm test` | Run test suite |

## Let LLM Set Up Your Flow Example

In **Chat**, you can ask the LLM to set up your workflow instead of doing everything manually.

Example prompts:

- `Create a team called Growth Ops for launch planning.`
- `For Growth Ops, set up task statuses: backlog, todo, in_progress, blocked, done.`
- `Create tasks for launch planning and place them in backlog.`
- `Set up a recurring Monday reminder to review launch risks.`
- `Create a playbook called Launch Checklist with clear handoff steps.`

Then review and refine in **Teams**, **Tasks**, **Scheduler**, and **Playbooks**.

## Playbooks

Use **Playbooks** to store reusable workflows (SOPs, checklists, scripts) your assistant can follow.

Common playbooks:

- New customer onboarding
- Weekly team planning
- Incident triage
- Release readiness checklist

## Channels (Optional)

Connect external channels in **Settings** -> **Channels**.

| Channel | Required keys |
| --- | --- |
| Telegram | `TELEGRAM_BOT_TOKEN` |
| Discord | `DISCORD_BOT_TOKEN` |
| Slack | `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` |
| WhatsApp | `WHATSAPP_PHONE_ID` |

## License

MIT
