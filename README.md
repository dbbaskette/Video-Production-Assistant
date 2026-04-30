# Video Production Assistant

Greenfield desktop studio that speeds up post-recording demo video creation. See `docs/superpowers/specs/` for design.

## Prerequisites

- Node 20+
- npm 10+

## Install

```bash
npm install
```

## Development

```bash
npm run dev          # runs each workspace's dev script (parallel runner added in Task 17)
npm run build        # build all packages
npm run test         # unit tests across workspaces
npm run e2e          # Playwright smoke tests (requires `npm run dev` running)
npm run typecheck    # tsc -b
npm run lint
```

## Environment

Copy `.env.example` to `.env` and adjust if needed. All defaults work for local single-user use.
