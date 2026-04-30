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

## Brand Library

VPA's Brand Library lets you create reusable brand profiles from documents (PDF, markdown, URL, free text, or existing design.md files). Each brand is stored as a Google Labs `design.md` file extended with VPA-specific fields under a `vpa:` namespace.

### Optional: install MarkItDown for higher-quality extraction

VPA ships with native PDF and URL extractors as a fallback, but PDF brand guidelines are typically better parsed by Microsoft's MarkItDown, which produces cleaner LLM-ready markdown. To enable it:

```bash
pip install 'markitdown[all]'
```

Restart the VPA server after installing.

### Where brands live

- Brand directories: `<vpa-home>/brands/<slug>/design.md`
- Registry: `<vpa-home>/brands.json`
- Editable LLM prompts: `prompts/brand-extract-tokens.md`, `prompts/brand-write-rationale.md`

### LLM provider

The current build uses a fake LLM provider that returns deterministic results for development. Real provider implementations are in a follow-on plan.

## License

TBD.
