# VeryBot Control UI

React + TypeScript + Vite frontend for the VeryBot control plane (chat, settings, logs, tasks, scheduler, teams, and playbooks).

## Requirements

- Node.js `>=22`
- npm or Bun

## Install

```bash
cd ui
npm install
```

## Run

Start backend from repository root:

```bash
npm run dev
```

Start UI in a second terminal:

```bash
cd ui
npm run dev
```

Notes:

- UI dev server is Vite (`http://localhost:10000` by default).
- WebSocket traffic (`/ws`) is proxied to the backend gateway.
- Default backend target is `http://localhost:28789`.
- Override backend target port with `GATEWAY_PORT=<port> npm run dev`.

## Scripts

```bash
npm run dev      # Vite dev server
npm run build    # Type-check + production build
npm run lint     # ESLint
npm run preview  # Preview production build locally
```

## Structure

```text
src/components/   Feature pages and UI primitives
src/contexts/     Shared React contexts
src/hooks/        Custom hooks
src/lib/          Utilities and helpers
src/locales/      i18n resources
src/index.css     Design tokens and global styles
```

## UI Conventions

- Follow `ui/CODESTYLE.md` for reusable UI conventions.
- Put feature-specific UI behavior decisions in `ui/docs/feature-ui-behavior-decisions.md`.
- Use shadcn/ui components and semantic design tokens.
- Keep all user-facing copy i18n-ready.
- Prefer hooks from `usehooks-ts` over custom equivalents when available.
