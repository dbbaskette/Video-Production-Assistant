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
- **ffmpeg / ffprobe with `drawtext` support** — needed for video metadata, recording splitting, lower-thirds rendering, and final video render. The default `brew install ffmpeg` formula often ships **without** the `freetype` library, which silently breaks the `drawtext` filter that lower-thirds depend on. Use the homebrew-ffmpeg tap, which builds with everything enabled by default:

  ```bash
  brew install homebrew-ffmpeg/ffmpeg/ffmpeg
  ```

  After install, confirm `drawtext` is available:

  ```bash
  ffmpeg -filters | grep drawtext
  # → T. drawtext  V->V  Draw text on top of video frames using libfreetype library.
  ```

  The in-app **Setup Health** page (top-right nav → **Setup**) probes this automatically and tells you what to fix when something is missing.

- [Claude Code](https://claude.ai/code) CLI installed and logged in for AI features (recommended, no API key needed), or a Gemini/Anthropic API key, or use `fake` provider for development

### Optional

```bash
pip install 'markitdown[all]'   # better PDF brand guideline extraction
npx playwright install chromium # only needed for E2E tests
```

### Optional — AI image generation (nano-banana)

For generating device-frame placeholders, scene preview thumbnails, brand
hero imagery, and other one-off visuals from inside a Claude Code session.
Uses Google's Gemini 3 Pro Image model (~$0.04–0.15 per image depending on
resolution).

Inside Claude Code, run:

```
/plugin marketplace add devonjones/devon-claude-skills
/plugin install nano-banana@devon-claude-skills
```

Then set a `GEMINI_API_KEY` (free key from
[Google AI Studio](https://aistudio.google.com/apikey)) in your shell or
the skill's `.env`. Python 3.8+ is required; the skill installs its own
dependencies (google-genai, Pillow, PyYAML).

Skip this if you're only running VPA — it isn't a runtime dependency, only
a developer-experience extra.

## What It Does

### Workflow

The left sidebar lays out the workflow as a sequence of dedicated phase pages. Every per-scene operation (narration, lower thirds, frame style, transition) is reachable from either the per-scene Recording tab OR the project-wide overview page for that phase — pick whichever fits the moment.

1. **Storyboard** — Chat with AI to plan a demo storyboard (or upload recordings and let AI generate one)
2. **Recordings** — Upload one MP4 per scene; the **Replace recording** button on the scene's Recording tab swaps files cleanly and invalidates the lower-thirds / frame caches
3. **Script** *(optional)* — Project-wide `/script` page shows every scene's script status with word count and inline preview. Click into any scene to write or AI-generate a draft. Monologue and dialog modes are edited independently with restore-previous backup.
4. **Voices** *(optional)* — Record or upload a voice clone in-browser; use it with Fish Audio (local) or register it as an xAI custom voice
5. **Narration** *(optional)* — Project-wide `/narration` page shows per-scene script + audio status. TTS engine produces per-paragraph MP3 chunks + SRT/VTT subtitles. Per-mode chunks survive monologue↔dialog toggling.
6. **Lower Thirds** *(optional)* — Project-wide `/lower-thirds` page shows LT counts + first titles + time ranges per scene. AI recommends overlays per scene; ffmpeg burns them onto video. Saving any edit (including deleting every entry) drops the cached overlay + framed video so the next render bakes from the current data.
7. **Render** — Dedicated `/render` page with brand-asset visibility, per-toggle opt-outs (narration, lower-thirds, brand bumpers, brand music), background music selector, and project-wide / per-scene frame style. Three-stage ffmpeg pipeline; SSE progress + inline playback.
8. **Quality Review** — AI inspection of the storyboard. Stale-cache banner reminds you to re-run after major changes. Optional features (narration, scripts, lower-thirds) are not flagged when absent. Narration-category warnings come with a **✨ Tighten script** button that asks the LLM to shorten the script to fit the recording duration, shows the proposal next to the current script, and (on accept) saves it + clears the stale TTS chunks.
9. **Export** *(optional)* — Collect all scene assets into an editor-ready bundle for external editing apps

### Features

| Feature | Description |
|---|---|
| **Brand Library** | Create reusable brand profiles from PDFs, URLs, or free text. Stored as `design.md` files. **Brand Assets** tab supports logos, **start/end bumpers** (videos), **default music** track, and other media — auto-applied to every render using that brand. Uploading a replacement asset removes the previous file from disk (skipped only when another field still references it), so the **Download** zip stays clean of orphans. **Usage** tab lists every project linked to the brand. |
| **Per-project Brand** | Apply a brand to a project; the picker on Project Overview and the badge in the sidebar surface the active brand. The Render page displays which brand assets will be applied + per-render opt-out checkboxes. |
| **Voices Library** | Record or upload voice clones in-browser; ffmpeg transcodes to canonical 24 kHz mono WAV. Use them with Fish Audio (local) or register them as xAI custom voices |
| **AI Ideation** | Chat-based storyboard planning with scene proposals and refinement |
| **Recording Ingestion** | Upload per-scene MP4s, or upload one long recording and split it at AI-proposed boundaries. **Replace recording** swaps a scene's video and automatically invalidates the cached lower-thirds bake + framed video. |
| **Script Generation** | AI writes narration scripts with emotive tags from scene context. Monologue and dialog modes are independent. Project-wide `/script` page lists every scene with word count + preview. Saving a script (manual edit, regenerate, or Quality Review "Tighten") clears any previously-generated TTS chunks so the next render doesn't play old narration over new wording. |
| **TTS Narration** | Per-paragraph chunked TTS with multiple engines/voices, word-level timing, SRT/VTT subtitles. Cloned voices appear automatically in the engine voice picker. |
| **Scene Preview** | Combined recording + narration + lower-thirds preview, played inline without rendering |
| **Lower Thirds** | AI-recommended title overlays with style/timing controls and ffmpeg rendering. Project-wide `/lower-thirds` page shows counts + first titles + time ranges per scene. Save / Recommend invalidates the baked overlay + framed video on disk, so the next render reflects exactly what's on the LT tab — including "I just deleted every entry, save the empty state." |
| **Scene Transitions** | Per-scene out-transitions ported from `tanzu-video-pipeline`: cut (default), crossfade, fade-black, fade-white, wipe-left/right, slide-left/right/up/down, circleopen/close, radial, pixelize. Configurable duration 0.1–5s. Render applies them via ffmpeg `xfade`. |
| **Per-scene Frame Style** | Each scene can override the project-default device frame (laptop / tablet / browser / none) and background (brand color / transparent / custom hex). |
| **Quality Review** | AI inspection of the full storyboard with severity-graded issue punch list. Optional features (narration, scripts, lower-thirds) are not flagged when absent. Stale-cache banner with one-click re-run when the project has changed since the last review. Narration warnings carry a **✨ Tighten script** action that proposes a shorter rewrite in a side-by-side modal and saves on accept (with a "heads up" if the proposal isn't actually shorter). |
| **Final Render** | Three-stage ffmpeg pipeline (audio concat → per-scene mux → multi-scene concat with xfade) with progress UI, brand-bumper prepend/append, brand default music fallback, per-render opt-outs for narration / lower-thirds / brand assets, and forced normalisation (scale + pad + setsar + settb) so mixed-source inputs always concat cleanly. **Download** button returns a `Content-Disposition: attachment` mp4 named after the project. |
| **Setup Health** | In-app probes for ffmpeg/drawtext, ffprobe, LLM connectivity, TTS providers, env vars, and `VPA_HOME` |
| **Export** | Bundle all scene assets into an organized directory with manifest for external editing apps |

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
| `GEMINI_API_KEY` | — | Required when `VPA_LLM_PROVIDER=gemini` and to enable Gemini TTS |
| `ANTHROPIC_API_KEY` | — | Required when `VPA_LLM_PROVIDER=anthropic` (direct REST API) |
| `XAI_API_KEY` | — | Enables xAI TTS (Sal/Eve/Ara/Leo/Rex) and xAI custom voice cloning. Custom voice **creation** via the API requires the Enterprise plan; the manual `voice_id` import flow works on any plan. |
| `XAI_TEAM_ID` | — | Optional. When set, the "Clone via xAI console →" link on a voice's detail page jumps directly to your team's voice library. Find your team id at https://console.x.ai/. |
| `FISH_AUDIO_MODEL` | `~/.lmstudio/models/mlx-community/fish-audio-s2-pro-bf16` | Path to a local Fish Audio MLX model. Also requires `mlx_audio` Python module (`scripts/setup-python.sh`). |

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
| `voice-clone/` | Per-voice directory layout (audio + transcript + meta), ffmpeg transcode, and xAI custom-voices client |
| `lower-thirds/` | AI lower-third recommendation |
| `overlay/` | ffmpeg lower-third overlay rendering |
| `render/` | Three-stage final-video pipeline: per-scene audio concat → mux → multi-scene concat |
| `setup/` | Dependency probes for the in-app `/setup` health check |
| `quality-review/` | AI storyboard quality inspection |
| `export/` | Asset bundling and manifest generation |
| `llm/` | LLM client interface + providers (fake, Claude Code, Gemini, Anthropic) with retry-on-transient-errors wrapper |

### Project Workspace Layout

```
~/Movies/VPA/my-demo/
  project.yaml           # project metadata, including applied brand
  storyboard.yaml        # scene definitions, scripts (monologue + dialog), per-mode chunks
  recordings/            # per-scene MP4 files
  narration/             # per-scene MP3 + SRT + VTT (and per-paragraph chunk MP3s)
  overlays/              # rendered videos with lower-third overlays
  renders/               # final.mp4 + per-scene mp4s from the render pipeline
  export/                # exported asset bundles
  source-docs/           # uploaded reference documents
```

### VPA_HOME Layout

```
~/.vpa/
  projects.json          # tracker of known projects
  brands/<slug>/         # brand kits (design.md + assets/)
  brands.json            # brand registry with default brand
  voices/*.yaml          # named voice profiles (engine + voice + speed)
  voice-clones/<slug>/   # per-voice clone directory: audio.wav + voice.json + transcript.txt
  models.json            # active LLM model selection
```

## Brand Library

Create reusable brand profiles from documents (PDF, markdown, URL, free text). Each brand is stored as a `design.md` file with VPA-specific extensions, plus a folder of asset files.

- Brand directories: `<VPA_HOME>/brands/<slug>/design.md`
- Brand assets: `<VPA_HOME>/brands/<slug>/assets/`
  - Logos: `assets/<filename>.{png,svg,jpg,webp}`
  - **Bumpers**: `assets/bumpers/<filename>.mp4` — start + end videos automatically prepended/appended at render time
  - **Default music**: `assets/music/<filename>.{mp3,wav,mp4}` — fallback background track when a project hasn't picked its own
  - Source docs: `assets/source-docs/`
- Registry: `<VPA_HOME>/brands.json`
- Voice profiles: `<VPA_HOME>/voices/*.yaml`
- Voice clones: `<VPA_HOME>/voice-clones/<slug>/`

Each project's `project.yaml` carries an applied brand reference (`brand: { id, applied_version }`); the active brand surfaces in the project sidebar and Overview. The brand-detail page has tabs for **Overview**, **Tokens**, **Markdown**, **Assets** (logos + bumpers + music upload UI with inline preview / remove), and **Usage** (every project linked to this brand). The **Download** button produces a zip of the entire brand for backup or sharing.

## Voices

A voice clone = your reference audio + metadata + provider registrations. Two providers are supported today:

- **Fish Audio** (local, no key): the `<slug>` audio file is passed as a reference clip on every TTS call. Pick `clone:<slug>` in the Fish engine voice picker.
- **xAI Custom Voices**: upload your audio to xAI once (`POST /v1/custom-voices`) → xAI returns an 8-character `voice_id`. The cloned voice then appears in the xAI engine voice picker. Custom voice creation requires the Enterprise plan; on lower tiers you can clone via the xAI console and paste the resulting `voice_id` into the manual import field on `/voices`.

The `/voices` page lets you record in-browser (`MediaRecorder` → server transcodes to 24 kHz mono WAV) or upload an existing clip in any common format.

## Final Render

The dedicated **/render** page runs a multi-stage ffmpeg pipeline:

1. **Bake** per-scene lower-thirds overlays on demand (cached at `overlays/<sceneId>-lower-thirds.mp4` and invalidated when the recording changes)
2. **Concatenate** per-paragraph narration chunks into a single audio track per scene (skipped entirely when **Include narration** is off — output is silent, recording's original audio is dropped)
3. **Mux** each scene's audio + overlay + optional device frame into `<project>/renders/<seq>-<slug>.mp4`. Audio mode = "replace original" or "mix narration over recording at -20dB" (only when narration is included). Optional subtitle burn-in.
4. **Normalise + concat** all scene mp4s — including any brand intro / outro bumpers — via a unified filter graph. Per-input `scale + pad + setsar + fps + settb=1/90000` ensures mixed-source clips (different fps, timebase, resolution) join cleanly. `xfade` is used at every scene boundary that has a configured transition; `concat` for cuts.
5. **Mix music** if a track is selected or the brand has a `default_music_track` (looped under narration at the configured volume; default −20 dB)

Per-render opt-outs surface as checkboxes on the Render page:

- **Include narration** — when off, the final video is silent regardless of what's been generated
- **Include lower thirds** — when off, ignores the baked overlay even if it exists on disk
- **Include bumpers** — start / end bumpers from the linked brand
- **Use brand default music** — falls back to the brand's music when no project track is picked

The **Download** link uses `?download=1&filename=<project>.mp4` so the browser saves a real file (cross-origin `download` attribute alone is ignored).

Progress streams over SSE (`/api/jobs/:jobId/stream`); the page shows a live progress bar and plays the result inline once done.

## Setup Health

Top-right nav → **Setup** runs nine probes (ffmpeg, drawtext filter, ffprobe, LLM connectivity, TTS providers, `XAI_API_KEY`, `XAI_TEAM_ID`, Fish Audio model + `mlx_audio` import, `VPA_HOME` writable) and surfaces actionable fix hints when something is missing. Useful right after a fresh install.

## License

TBD.
