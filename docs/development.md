# VeryBot Development Guide

## Requirements

- Node.js `>=22`
- npm

## Install

```bash
git clone https://github.com/charlie0077/verybot.git
cd verybot
npm install
```

Note: root `npm install` also installs UI dependencies via postinstall.

## Run Locally

### Full stack (recommended)

```bash
npm run dev
```

- Control UI: `http://localhost:10000`
- Backend API/Gateway: `http://localhost:28789`

### Backend only

```bash
npm run dev:backend
```

### LAN testing

```bash
npm run dev:lan
```

This binds UI dev server to `0.0.0.0:10000`.

## Build and Test

```bash
npm run build
npm test
```

Run production build:

```bash
npm start
```

## Common Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Backend + UI dev servers |
| `npm run dev:backend` | Backend watcher (`tsx watch src/index.ts`) |
| `npm run dev:lan` | LAN-accessible UI dev server |
| `npm run build` | Build backend and UI to `dist/` |
| `npm start` | Run `dist/index.js` |
| `npm test` | Run Vitest |
| `npm run test:watch` | Run Vitest in watch mode |

## Project Layout

```text
src/        Backend runtime, tools, channels, gateway, stores
ui/         React control UI
scripts/    Operational and migration scripts
docs/       Project docs
dist/       Build output
```

## Contributing

Before opening a PR:

```bash
npm test
npm run build
```
