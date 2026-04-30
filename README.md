# Video Production Assistant

Greenfield desktop studio that speeds up the post-recording phase of demo video creation. See `docs/superpowers/specs/` for design and `docs/superpowers/plans/` for implementation plans.

## Status

Plan 01 — Foundation & Project Store: **complete**. Server + web shells stand up, projects can be created and imported, dashboard lists them. No video features yet (Plans 02+).

## Prerequisites

- Node 20+
- npm 10+

## Install

```bash
npm install
npx playwright install chromium    # only needed for E2E tests
```

## Run in development

```bash
npm run dev
```

This starts:
- `vpa-server` on http://127.0.0.1:3000 (Fastify)
- `vpa-web` on http://localhost:5173 (Vite)

Open http://localhost:5173 in your browser.

## Verification commands

```bash
npm run typecheck   # tsc -b across workspaces
npm run lint        # ESLint
npm test            # Vitest unit/integration tests
npm run build       # build all packages
npm run e2e         # Playwright smoke (boots dev servers automatically)
```

## Configuration

Copy `.env.example` to `.env` and adjust if needed.

| Variable | Default | Purpose |
|---|---|---|
| `VPA_HOME` | `~/.vpa` | App config directory (tracker, future brands/voices) |
| `VPA_PROJECTS_DEFAULT` | `~/Movies/VPA` | Default parent directory for new projects |
| `VPA_SERVER_PORT` | `3000` | Server port |
| `VPA_SERVER_HOST` | `127.0.0.1` | Server bind address (localhost-only) |
| `VITE_VPA_API_BASE` | `http://localhost:3000` | Web app's API base URL |

## Repo layout

```
apps/server/          Fastify server (services + routes)
apps/web/             Vite + React studio
packages/shared/      Shared zod schemas + types
tests/e2e/            Playwright smoke tests
docs/superpowers/     Spec and plan documents
```

## License

TBD.
