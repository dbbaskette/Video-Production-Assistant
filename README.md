# Video Production Assistant

Desktop studio that speeds up the post-recording phase of demo video creation. Upload raw screen recordings, generate narrated audio with subtitles, add lower-third overlays, and export editor-ready assets.

## Quick Start

```bash
cp .env.example .env          # configure LLM provider + API keys
./start.sh                    # install deps + start dev servers
```

Open http://localhost:5173 in your browser.

## Prerequisites

- **Node.js 20+** and **npm 10+**
- **ffmpeg / ffprobe** — required for video metadata, recording splitting, and overlay rendering
- [Claude Code](https://claude.ai/code) CLI installed and logged in for AI features (recommended, no API key needed), or a Gemini/Anthropic API key, or use `fake` provider for development

### Optional

```bash
pip install 'markitdown[all]'   # better PDF brand guideline extraction
npx playwright install chromium # only needed for E2E tests
```

## What It Does

### Workflow

1. **Ideate** — Chat with AI to plan a demo storyboard (or upload recordings and let AI generate one)
2. **Record** — Record each scene as an MP4 against the storyboard
3. **Script** — AI generates narration scripts from your recordings
4. **Narrate** — TTS engine produces MP3 audio + SRT/VTT subtitles
5. **Lower Thirds** — AI recommends on-screen title overlays; render them onto video with ffmpeg
6. **Review** — AI quality review catches missing assets, unclear descriptions, timing issues
7. **Export** — Collect all scene assets into an editor-ready bundle

### Features

| Feature | Description |
|---|---|
| **Brand Library** | Create reusable brand profiles from PDFs, URLs, or free text. Stored as `design.md` files. |
| **AI Ideation** | Chat-based storyboard planning with scene proposals and refinement |
| **Recording Ingestion** | Upload per-scene MP4s, or upload one long recording and split it at AI-proposed boundaries |
| **Script Generation** | AI writes narration scripts with emotive tags from scene context |
| **TTS Narration** | Text-to-speech with multiple engines/voices, word-level timing, SRT/VTT subtitles |
| **Lower Thirds** | AI-recommended title overlays with style/timing controls and ffmpeg rendering |
| **Quality Review** | AI inspection of the full storyboard with severity-graded issue punch list |
| **Export** | Bundle all assets per scene into an organized directory with manifest |

## Configuration

Copy `.env.example` to `.env` and adjust:

| Variable | Default | Purpose |
|---|---|---|
| `VPA_HOME` | `~/.vpa` | App config (tracker, brands, voice profiles) |
| `VPA_PROJECTS_DEFAULT` | `~/Movies/VPA` | Default parent directory for new projects |
| `VPA_SERVER_PORT` | `3000` | Server port |
| `VPA_SERVER_HOST` | `127.0.0.1` | Server bind address |
| `VITE_VPA_API_BASE` | `http://localhost:3000` | Web app API base URL |
| `VPA_LLM_PROVIDER` | `fake` | LLM backend: `fake`, `claude-code`, `gemini`, or `anthropic` |
| `VPA_LLM_MODEL` | — | Optional model override (e.g. `sonnet`, `gemini-2.5-flash-lite`) |
| `GEMINI_API_KEY` | — | Required when `VPA_LLM_PROVIDER=gemini` |
| `ANTHROPIC_API_KEY` | — | Required when `VPA_LLM_PROVIDER=anthropic` (direct REST API) |

### LLM Providers

**Fake** (default) — deterministic responses for development. No API key needed.

**Claude Code** (recommended) — uses `claude -p` subprocess. Requires [Claude Code](https://claude.ai/code) installed and logged in. No API key needed — uses your Claude subscription. Set `VPA_LLM_PROVIDER=claude-code`.

**Gemini** — Google's Gemini REST API. Set `VPA_LLM_PROVIDER=gemini` and `GEMINI_API_KEY`.

**Anthropic** — Direct Anthropic REST API. Set `VPA_LLM_PROVIDER=anthropic` and `ANTHROPIC_API_KEY`.

## Development

```bash
npm run dev          # start server + web with hot reload
npm run typecheck    # TypeScript check across all workspaces
npm run lint         # ESLint
npm test             # Vitest unit/integration tests
npm run build        # build all packages
npm run e2e          # Playwright E2E tests
```

### Start Script

```bash
./start.sh             # dev mode (default)
./start.sh --build     # install + build first, then dev mode
./start.sh --prod      # production mode (built assets, no hot reload)
./start.sh --help      # show all options
```

## Architecture

```
apps/server/          Fastify REST server (services + routes)
apps/web/             Vite + React studio UI
packages/shared/      Shared Zod schemas + TypeScript types
prompts/              Editable LLM system prompts
tests/e2e/            Playwright E2E tests
docs/superpowers/     Design specs and implementation plans
```

### Server Services

| Service | Purpose |
|---|---|
| `project/` | Project CRUD, tracker, workspace paths |
| `brand/` | Brand registry, design.md parsing, fork/delete |
| `brand-generation/` | LLM-powered brand token extraction and rationale writing |
| `storyboard/` | Storyboard YAML CRUD, scene management |
| `ideation/` | AI chat sessions for storyboard planning |
| `recording/` | Video ingestion, metadata (ffprobe), single-file splitting |
| `video-analysis/` | LLM-based scene description from recording metadata |
| `script/` | AI narration script generation |
| `narration/` | TTS orchestration, subtitle generation (SRT/VTT) |
| `tts/` | TTS provider plugin system (fake, extensible) |
| `voice-profile/` | YAML-based voice profile CRUD |
| `lower-thirds/` | AI lower-third recommendation |
| `overlay/` | ffmpeg lower-third overlay rendering |
| `quality-review/` | AI storyboard quality inspection |
| `export/` | Asset bundling and manifest generation |
| `llm/` | LLM client interface + providers (fake, Claude Code, Gemini, Anthropic) |

### Project Workspace Layout

```
~/Movies/VPA/my-demo/
  project.yaml           # project metadata
  storyboard.yaml        # scene definitions + all metadata
  recordings/            # per-scene MP4 files
  narration/             # per-scene MP3 + SRT + VTT
  overlays/              # rendered videos with lower-third overlays
  export/                # exported asset bundles
  source-docs/           # uploaded reference documents
```

## Brand Library

Create reusable brand profiles from documents (PDF, markdown, URL, free text). Each brand is stored as a `design.md` file with VPA-specific extensions.

- Brand directories: `<VPA_HOME>/brands/<slug>/design.md`
- Registry: `<VPA_HOME>/brands.json`
- Voice profiles: `<VPA_HOME>/voices/*.yaml`

## License

TBD.
