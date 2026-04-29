# Video Production Assistant — Phase 1 Design

**Status:** Draft
**Date:** 2026-04-29
**Author:** dbbaskette + Claude (brainstorm session)
**Sibling project:** [tanzu-video-pipeline](../../../../tanzu-video-pipeline) (TVP)

---

## 1. Purpose & Scope

VPA is a greenfield desktop studio that **speeds up the post-recording phase of demo video creation**. Unlike its sibling TVP, VPA does not automate recording (no director, no shoot, no replay). It picks up where the human-recorded demo ends and turns raw MP4s into the assets a video editor needs: storyboards, narrated audio, subtitles, lower-thirds metadata, and lower-third overlay renders.

**Phase 1 = asset factory.** Inputs go in, scene-level assets come out. The user takes those assets to Final Cut / Premiere / DaVinci to assemble the final cut. Phase 2 (out of scope here) will add a stitch/finish stage that produces a final branded MP4 from the same data model.

**Non-goals (Phase 1):**
- Recording, screen capture, or driving applications
- Final video stitching, transitions, or composite render
- Multi-user, cloud, or auth
- Pacing/cut recommendation (deferred to Potential Enhancement)
- Slide scenes (schema reserves the type; renderer deferred)

---

## 2. User Workflows

### 2.1 Ideation-first (default)

1. User lands on the dashboard, clicks **"Ideate a new demo."**
2. Names the project, picks a folder root (default `~/Movies/VPA/<name>/`).
3. Drops in source documents (PDFs, markdown, URLs) and types a natural-language objective.
4. Chats with AI. The right pane shows the storyboard updating live as scenes are proposed, refined, reordered. User clicks any scene to ask AI to refine just that one.
5. Clicks **Accept**. `storyboard.yaml` is written. Project workspace opens.
6. User goes off and records each scene as an MP4 against the storyboard.
7. Returns, uploads recordings, runs script + narration + lower-thirds per scene, runs Quality Review, exports.

### 2.2 Recording-first

1. User clicks **"I have recordings."**
2. Names the project, picks a folder root.
3. Uploads either:
   - **Multi-file:** one MP4 per scene. Each becomes a scene; user names them.
   - **Single-file:** one long MP4. AI proposes scene boundaries — each as `{ start_sec, end_sec, suggested_name }`. User confirms/edits in a list view (numeric inputs, no scrubber). On confirm, ffmpeg clips the source into per-scene MP4s under `recordings/`; the original is kept under `recordings/_source.mp4` for re-splitting if the user changes their mind.
4. AI generates scene descriptions by watching each clip. `storyboard.yaml` is written.
5. From here, identical to Ideation-first step 7.

### 2.3 Per-scene loop (the core gesture)

For each scene, on the scene page:

1. **Recording tab** — confirm the source MP4, see metadata (duration, resolution).
2. **Script tab** — click "Generate script." AI watches the MP4 and writes an emotive narration script (Gemini-superset emotive tags). User edits inline.
3. **Narration tab** — pick TTS engine (dropdown) and voice profile. Click Generate. Listen, edit script if needed, regenerate. Save as `narration/scene-N.mp3` plus `.srt` and `.vtt`.
4. **Lower Thirds tab** — review AI-proposed lower thirds (initial guess from scene description, refined by watching the recording). Edit text, timing, style. Optional: click **Render** to produce `overlays/scene-N-with-lower-thirds.mp4`.

### 2.4 Quality review

On the project Overview page, click **Run Quality Review.** AI inspects the storyboard and emits a punch list:

- Scene descriptions (clarity, missing info)
- Lower-third copy (length, on-brand)
- Narration length sanity vs. recording duration
- Missing assets

Each item has severity (info / warn / issue) and a "Jump to" link that opens the relevant editor.

---

## 3. Architecture

### 3.1 Topology

```
┌─────────────────────────────────────────────────────────┐
│  Vite + React (web studio)        http://localhost:5173 │
│  Pages: Dashboard · Project · Library · Settings        │
└──────────────────┬──────────────────────────────────────┘
                   │ REST + SSE (CORS locked to localhost)
┌──────────────────▼──────────────────────────────────────┐
│  Fastify server                   http://localhost:3000 │
│  Routes are thin adapters — no business logic           │
│  In-process job queue (concurrency cap = 2)             │
└──┬──────┬──────┬──────┬──────┬──────┬──────┬────────────┘
   │      │      │      │      │      │      │
┌──▼──┐┌──▼──┐┌──▼──┐┌──▼──┐┌──▼──┐┌──▼──┐┌──▼─────────┐
│story││ llm ││ tts ││video││lower││brand││ project    │
│board││     ││     ││analy││thirds││     ││ store      │
└─────┘└─────┘└─────┘└─────┘└─────┘└─────┘└────────────┘
   │      │      │      │      │      │
   └──────┴──────┴──────┴──────┴──────┘
                │
       ┌────────▼─────────┐
       │ pluggable        │
       │ providers        │
       │ • Gemini API     │
       │ • Claude -p      │
       │ • xAI            │
       │ • local TTS      │
       └──────────────────┘
```

### 3.2 Design rules

1. **Services are pure modules.** Fastify routes call them; a future CLI can import them directly. No business logic in route handlers.
2. **Providers are plugins.** TTS and LLM both implement a small interface (`generate(input, opts) → output | stream`). New engines drop in without UI changes.
3. **`storyboard.yaml` is the contract.** Every feature reads/writes through it; manual hand-edits are always valid.
4. **Long-running jobs stream over SSE.** UI shows progress, can be backgrounded, survives tab switches (not server restarts in Phase 1).
5. **All paths in `storyboard.yaml` are relative to the project root.** Projects are portable — move the folder, paths still work.
6. **Idempotent stages.** Re-running clears that stage's slot in `state.yaml` and regenerates output; old artifacts are overwritten.

### 3.3 Service boundaries

Each service is a directory under `src/services/` exporting a small, typed API. None of them know about HTTP.

| Service | Responsibility |
|---|---|
| `storyboardService` | Load / validate / mutate / save `storyboard.yaml`. Schema versioning. |
| `projectStore` | Project CRUD, tracker file in `~/.vpa/projects.json`, default-folder logic. |
| `llmService` | Provider-agnostic LLM calls (chat + structured output). Used by ideation, scene description, lower-third recommender, quality review. |
| `ttsService` | Provider-agnostic TTS. Engine dropdown maps to provider. Returns audio bytes + word-level timings if the provider supplies them. |
| `videoAnalysisService` | "Watch this MP4 and …" — used by script generation, scene splitter, lower-third refinement. Backed by Gemini video API. |
| `narrationService` | Orchestrates: script → TTS → mp3 + .srt + .vtt. Subtitles are derived from TTS timings, no separate ASR pass. |
| `lowerThirdsService` | Recommend (LLM call), refine (video analysis call), render overlay (Remotion or canvas pipeline ported from TVP). |
| `brandService` | Brand CRUD in `~/.vpa/brands/`. Bootstrap-from-docs (LLM reads brand PDFs/markdown → emits `guidelines.md` + `tokens.json`). Bundled Tanzu seed brand. |
| `voiceProfileService` | YAML files in `~/.vpa/voices/`. Load/save/list. |
| `promptStore` | Editable system prompts in `prompts/*.md`. Hot-reloaded — no rebuild needed. |
| `jobQueue` | In-process queue. Concurrency cap configurable (default 2). Persists state transitions to `state.yaml`. Emits SSE events. |

### 3.4 Provider plugin shape

```ts
// services/llm/provider.ts
interface LlmProvider {
  id: 'gemini' | 'claude-cli' | 'claude-api' | 'xai' | string;
  chat(messages: Message[], opts: ChatOpts): AsyncIterable<TextChunk>;
  structured<T>(prompt: string, schema: ZodSchema<T>, opts: StructuredOpts): Promise<T>;
}

// services/tts/provider.ts
interface TtsProvider {
  id: 'gemini' | 'xai' | 'voicebox' | 'kokoro' | string;
  supportedEmotives: Set<string>;
  generate(script: string, opts: TtsOpts): Promise<{
    audio: Buffer;
    timings?: Array<{ word: string; t: number }>;
  }>;
}
```

Providers are registered at startup. The TTS dropdown in the UI lists registered providers. New providers (e.g., a local Voicebox) drop in by adding a file under `src/services/tts/providers/` and registering it.

**Emotive validation is non-blocking.** Before a TTS call, the narration service compares emotive tags in the script to the chosen provider's `supportedEmotives`. Unsupported tags surface as a yellow warning in the UI ("`[curious]` may not work with xAI") but the call proceeds — Gemini's superset works in xAI in practice often enough to be worth letting through.

### 3.5 Repo layout

```
Video-Production-Assistant/
├── apps/
│   ├── web/              # Vite + React studio
│   │   ├── src/
│   │   │   ├── pages/    # Dashboard, Project, Scene, Library, Settings
│   │   │   ├── components/
│   │   │   ├── hooks/    # useProject, useStoryboard, useJob (SSE)
│   │   │   └── lib/      # api client
│   │   ├── index.html
│   │   └── vite.config.ts
│   └── server/           # Fastify
│       ├── src/
│       │   ├── routes/   # thin REST + SSE adapters
│       │   ├── services/ # all real work — pure modules
│       │   │   ├── storyboard/
│       │   │   ├── project/
│       │   │   ├── llm/
│       │   │   │   └── providers/
│       │   │   ├── tts/
│       │   │   │   └── providers/
│       │   │   ├── video-analysis/
│       │   │   ├── narration/
│       │   │   ├── lower-thirds/
│       │   │   ├── brand/
│       │   │   ├── voice-profile/
│       │   │   ├── prompt-store/
│       │   │   └── job-queue/
│       │   ├── schema/   # zod schemas: storyboard, project, brand, voice
│       │   └── server.ts
│       └── tsconfig.json
├── packages/
│   └── shared/           # types shared between web + server
├── prompts/              # editable LLM system prompts (markdown)
├── brands/
│   └── tanzu/            # bundled seed brand (copied to ~/.vpa/brands/ on first run)
├── docs/
│   └── superpowers/
│       └── specs/        # this file
├── samples/              # example storyboards for testing
├── tests/                # Playwright smoke E2E
├── package.json          # workspace root
└── README.md
```

---

## 4. Data Model — `storyboard.yaml`

```yaml
schema_version: 1
project:
  id: <uuid>
  name: gpdb-mcp-walkthrough
  created: 2026-04-29T14:00:00Z
  objective: "Show how MCP plugs into Greenplum"
  audience: "Tanzu field SEs"
  source_docs:
    - docs/mcp-overview.pdf
    - https://blog/example

defaults:
  brand: tanzu                  # → ~/.vpa/brands/tanzu/
  voice_profile: tanzu-narrator # → ~/.vpa/voices/tanzu-narrator.yaml
  tts_engine: gemini

scenes:
  - id: scene-01
    name: "Configure the MCP Server"
    description: "Show editing claude_desktop_config.json with the new server entry"
    type: desktop               # desktop | terminal | browser | slide (slide reserved, deferred)

    recording:
      source: recordings/scene-01.mp4
      duration_sec: 47.2
      ingested_at: 2026-04-29T14:12:00Z

    narration:
      script: |
        [warm] Let's start by wiring up the MCP server.
        [thoughtful] You'll edit your Claude Desktop config…
      audio: narration/scene-01.mp3
      subtitles:
        srt: narration/scene-01.srt
        vtt: narration/scene-01.vtt
      tts:
        engine: gemini          # overrides defaults if set
        voice: Kore
        speed: 1.0
      timings:
        - { word: "Let's", t: 0.00 }
        - { word: "start", t: 0.21 }

    lower_thirds:
      - title: "MCP Server Setup"
        subtitle: "Tanzu MCP"
        style: frosted          # frosted | solid | minimal
        in_sec: 2.0
        out_sec: 6.5
    overlay_render: overlays/scene-01-with-lower-thirds.mp4   # optional, written if rendered

    review:                     # populated by quality review
      status: ok                # ok | warnings | issues
      notes: []

state:
  ideation: complete
  ingestion: complete
  scripts: { "scene-01": complete, "scene-02": pending }
  narration: { "scene-01": complete }
  lower_thirds: { "scene-01": complete }
  subtitles: { "scene-01": complete }
  review: pending
```

### 4.1 Storage layout on disk

```
~/.vpa/                              # app config (always)
├── projects.json                    # tracker: [{ id, name, path, lastOpened }]
├── brands/
│   └── tanzu/
│       ├── guidelines.md
│       └── tokens.json
├── voices/
│   └── tanzu-narrator.yaml
└── settings.json                    # user prefs (default brand, default voice, concurrency)

<project root>/                      # default ~/Movies/VPA/<name>/
├── project.yaml                     # project metadata (id, name, created, objective)
├── storyboard.yaml                  # source of truth
├── recordings/
│   ├── scene-01.mp4
│   └── scene-02.mp4
├── narration/
│   ├── scene-01.mp3
│   ├── scene-01.srt
│   └── scene-01.vtt
├── overlays/
│   └── scene-01-with-lower-thirds.mp4
├── source-docs/                     # uploaded ideation inputs (optional, for re-runs)
└── state.yaml                       # job checkpoints
```

---

## 5. UI Specification

### 5.1 Navigation shape — project-centric

Left sidebar in the project workspace acts as the project's table of contents:

```
gpdb-mcp-walkthrough
├─ ▸ Overview        (project summary, quality review button)
├─ ▸ Storyboard      (full storyboard editor — scene list, reorder, edit YAML directly)
├─ ▸ Scenes
│   ├─ scene-01
│   ├─ scene-02
│   └─ scene-03
└─ ▸ Review          (results of last quality review)

← All projects
─────────
LIBRARY
· Prompts
· Voices
· Brands
· On-Demand TTS
─────────
Settings
```

### 5.2 Dashboard

Two large CTAs side-by-side, recent projects below:

```
┌──────────────────────────┬──────────────────────────┐
│  💡  Ideate a new demo    │  📹  I have recordings   │
│  Drop docs + describe     │  Upload mp4(s); we'll    │
│  what to demo             │  script & narrate        │
└──────────────────────────┴──────────────────────────┘

RECENT
· gpdb-mcp-walkthrough    edited 2h ago
· acme-launch-q2          3d ago
· tanzu-platform-overview 1w ago
```

Header bar: "Open folder…" button (for projects not in the tracker — e.g., one moved from another machine).

### 5.3 Ideation page (chat + live storyboard)

Two-column split:

- **Left:** chat history + reply box. AI responses can include structured proposals that render inline as scene chips.
- **Right:** live storyboard preview. Scenes appear/update/reorder in real time. Each scene has an inline ✏ button — clicking it sends a scoped refinement message ("Make scene 3 shorter and focus on the SQL output").
- **Bottom-right:** **Accept & create storyboard** button. Disabled until storyboard has ≥1 scene.

### 5.4 Scene page (three-pane + read-only timeline)

```
┌──────────────────────────────────────────────────────────────────┐
│  scene-01: Configure the MCP Server                              │
├────────────────┬─────────────────────────┬───────────────────────┤
│ ▶ Video        │ Script                   │ Narration            │
│   recording    │ [warm] Let's start by    │ engine: [gemini  ▾]  │
│   (16:9)       │ wiring up the MCP        │ voice:  [Kore     ▾] │
│                │ server. [thoughtful]…    │ profile:[tanzu… ▾]   │
│   47.2s        │                          │                      │
│   1920×1080    │ [Regenerate] [Save]      │ [Generate] [▶ Play]  │
├────────────────┴─────────────────────────┴───────────────────────┤
│  TIMELINE  (read-only)                                           │
│  ▮▮░░░░░░░░░░░░▮░░░░░░░░░░▮░░░░░░░░░░░░░░░░░░░░░░░░░             │
│  0s     10s     20s     30s     40s    47s                       │
│  ▲ playhead  ▮ lower-third blocks  waveform underlay             │
├──────────────────────────────────────────────────────────────────┤
│  LOWER THIRDS                                                    │
│  · "MCP Server Setup" frosted  in 2.0s  out 6.5s   [Preview]     │
│  · "claude_desktop_config.json" minimal  18.0–22.0s [Preview]    │
│  [+ Add lower third]    [Render scene with LTs]                  │
└──────────────────────────────────────────────────────────────────┘
```

- The timeline strip shows narration waveform + LT block positions + playhead synced to the video. **Read-only for editing** — drag-to-edit deferred to Potential Enhancement; LT timing edits via numeric input. Clicking the timeline *does* scrub the video preview (cheap to implement, big UX win).
- "Preview" on a lower third renders just that overlay on a 5-second window of the recording (fast, for tweaking copy/style).
- "Render scene with LTs" produces `overlays/scene-N-with-lower-thirds.mp4` (full scene, all LTs baked in).

### 5.5 Library

List-detail pattern. Left rail = items, right pane = editor.

- **Prompts** — editable system prompts (`ideation.md`, `scene-description.md`, `lower-third-recommender.md`, `narration-writer.md`, `quality-review.md`). Markdown editor with YAML frontmatter for prompt metadata. Hot-reloaded.
- **Voices** — voice profiles. Editor shows engine, voice ID, default style, speed. "Save as profile" button on the scene page Narration tab adds new entries here.
- **Brands** — list of brands. Detail view shows guidelines.md (markdown editor) and tokens.json (JSON editor with preview chips for colors). "Create from documents" launches a brand-bootstrap wizard: drop files → AI generates → review → save.
- **On-Demand TTS** — single-form page (not list-detail). Engine dropdown, voice dropdown, script textarea, Generate, ▶ Play, Save-As. Independent of any project.

### 5.6 Settings

Single page. Sections: Default brand, Default voice profile, Default TTS engine, Concurrency cap, Provider credentials (env vars + masked fields), Project folder default path.

---

## 6. Job Queue & Progress

### 6.1 Shape

A long-running operation (LLM call, TTS, video analysis, render) is a **job**:

```ts
type Job = {
  id: string;                // uuid
  kind: 'ideation' | 'script' | 'narration' | 'lower-thirds-recommend' |
        'lower-thirds-render' | 'scene-split' | 'quality-review' | 'brand-bootstrap';
  projectId?: string;
  sceneId?: string;
  status: 'pending' | 'running' | 'complete' | 'failed' | 'canceled';
  progress: number;          // 0..1
  message?: string;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
};
```

### 6.2 Lifecycle

1. UI POSTs to `/api/jobs` with `{ kind, ...params }`. Server enqueues, returns `{ jobId }`.
2. Server runs at most `concurrencyCap` jobs concurrently (default 2).
3. UI subscribes to `/api/jobs/:id/events` (SSE). Receives status/progress/message events. **On (re)connect, the server replays the full event history for that job** (kept in memory while the job is alive, then for 5 minutes after completion) so a tab switch or page reload doesn't lose progress display.
4. On completion, server writes outputs to disk, updates `storyboard.yaml` and `state.yaml`, emits a final `complete` event, and persists job to `~/.vpa/jobs.log` (last 500).
5. On failure, server emits `failed` event with error message; no auto-retry.

### 6.3 Survival

- Survives **tab switches** (jobs run on the server; UI re-subscribes on remount).
- Does **not** survive server restart in Phase 1. If the server dies mid-job, the job is lost; `state.yaml` shows the slot as "pending" and the user re-runs. (Persistent queue is Phase 2.)

---

## 7. Idempotency & Error Handling

- Every stage that writes outputs first deletes the prior output for that scope. Re-running scene-01 narration overwrites `narration/scene-01.mp3` and clears `state.yaml.narration["scene-01"]` before regenerating.
- Failures surface as a toast in the UI plus a per-scene job log entry. The relevant `state.yaml` slot stays `pending` (not `failed`), so the next run is a clean re-attempt.
- The user can always hand-edit `storyboard.yaml`. The next service load validates against the schema; invalid edits show a banner with the validation error and a "Revert to last good version" button (last good version stored as `storyboard.yaml.bak` after every successful service-driven save).

---

## 8. Security & Privacy

- **Localhost only.** Server binds 127.0.0.1. CORS allowlist is `http://localhost:5173` only.
- **No auth.** Single-user app.
- **API keys** live in `~/.vpa/settings.json` (or `.env` if user prefers). Masked in the UI. Never logged.
- **No telemetry.** No analytics, no error reporting service.
- **Source docs and recordings stay on disk.** They're sent to LLM/TTS providers only when the user triggers a job that requires it.

---

## 9. Testing Strategy

- **Vitest** for service unit tests. LLM and TTS providers mocked at the interface boundary.
- **Playwright smoke E2E.** One golden-path test: create project → upload mp4 → generate script → generate narration → see LT proposals → run quality review.
- **Real-provider integration tests** gated behind `VPA_RUN_INTEGRATION=1`. Run pre-release.
- **Schema tests.** Round-trip every sample `storyboard.yaml` through load → validate → save → diff. Catches schema drift.
- **No coverage target** for Phase 1. Focus tests on services, not routes (routes are thin).

---

## 10. Open Questions for Phase 2 / Potential Enhancements

These are explicitly **out of scope** for Phase 1 but the design preserves room for them:

- **Stitch / finish stage** — produce a final branded MP4 from the same `storyboard.yaml`. Schema already includes everything needed (per-scene timing, LTs, narration audio paths, transitions field can be added without breaking changes).
- **Pacing analysis** — TVP-style cut/speed-up region detection. Would add `pacing_regions` field per scene.
- **Slide scenes** — `type: slide` already reserved; add a renderer.
- **Drag-to-edit timeline** — replace read-only timeline with a real editor (waveform library, drag handles for LT in/out).
- **Persistent job queue** — survive server restart.
- **Programmatic export bundle** — zip a project + render tarball for handoff.
- **CLI** — add a `vpa` CLI that imports the same service modules. Design rule #1 (services are pure modules) makes this trivial.
- **Production meeting** — TVP-style multi-round Director vs Producer debate over storyboard quality.

---

## 11. Implementation Order (Suggested Slices for Plan)

The plan that follows this spec should slice the work so the app is usable end-to-end as early as possible. A reasonable shape:

1. **Slice 0 — Skeleton:** workspace, Vite + React shell, Fastify shell, project store, dashboard, "Open folder…", project tracker.
2. **Slice 1 — Storyboard backbone:** schema + service, Storyboard page (load/edit YAML in-app), state.yaml, sample storyboard for tests.
3. **Slice 2 — Ideation:** LLM service + Gemini provider + Claude-CLI provider, ideation chat + live storyboard pane, prompt store, sample prompts.
4. **Slice 3 — Recording ingestion:** multi-file upload, single-file + AI scene splitter, video analysis service, scene description generator.
5. **Slice 4 — Script generation:** scene page shell, video preview, script tab, generate-from-video.
6. **Slice 5 — TTS + narration:** TTS service + Gemini provider + xAI provider, narration tab, voice profile service + Library page, subtitle emission.
7. **Slice 6 — Lower thirds:** recommender, refiner, scene-page LT pane, preview render, full-scene render, Remotion (or canvas) overlay pipeline ported from TVP.
8. **Slice 7 — Brands:** brand service, bundled Tanzu seed, brand-bootstrap-from-docs, Library Brands page.
9. **Slice 8 — Quality review:** prompt + service + Overview-page button + Review page.
10. **Slice 9 — Polish:** On-Demand TTS page, Settings page, error states, Playwright smoke test.

Slices 0–2 deliver the Ideation-first happy path without recordings. Slices 3–6 deliver the per-scene loop. Slices 7–9 fill in the rest.

---

## 12. Glossary

- **Asset factory** — Phase 1's identity. VPA produces per-scene assets, doesn't render the final video.
- **Emotive tag** — bracketed style cue in narration script (e.g. `[warm]`, `[thoughtful]`). Canonical set is Gemini's; xAI tolerates the superset in practice.
- **Lower third** — graphic overlay (title + subtitle + style) burned in over a portion of a scene.
- **Storyboard** — the YAML document that defines the project. Single source of truth.
- **Voice profile** — saved bundle of TTS engine + voice + style. Reusable across scenes and projects.
- **Brand** — bundle of guidelines.md + tokens.json (+ optional logo) that styles lower thirds and (Phase 2) the final render.
