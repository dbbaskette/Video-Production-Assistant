# UX Global-State Batch — Implementation Plan

**Goal:** Surface global project state where the user already is, and make destructive edits safe & reversible. Four reinforcing features delivered as one batch (mirroring PR #48).

**Architecture:** Frontend-heavy. One server-side chokepoint already exists (`saveStoryboard`) — we hook it for snapshots. Job queue is in place — we add a list endpoint for the tray. Everything else is React + React Query.

**Tech Stack:** React 18, React Query, Fastify, Zod. No new deps planned.

---

## Feature 1 — Warn before destructive saves

**Problem:** [apps/server/src/routes/scripts.ts:237](apps/server/src/routes/scripts.ts:237) silently wipes `chunks/audio/subtitles/timings` when a script is saved. Lower-thirds saves invalidate the baked overlay. Recording replace cascades through everything. Users discover this at Render time.

**Approach:** Server returns a *what-would-be-discarded* preview from a dry-run-style query parameter. Client wraps the relevant mutations with a `confirmDestructive` helper that shows the preview in a `UiProvider.confirm()` modal before executing.

### Files

- **Modify** `apps/server/src/routes/scripts.ts` — accept `?dryRun=1` on PUT `/script` and PUT `/intent`; return `{ wouldDiscard: { chunks: n, audioMs: n, subtitles: n } }` without mutating.
- **Modify** `apps/server/src/routes/lower-thirds.ts` — same `?dryRun=1` pattern; return `{ wouldDiscard: { bakedOverlay: bool, framedVideo: bool } }`.
- **Modify** `apps/server/src/routes/recordings.ts` — for replace-recording, return preview of cascaded discards.
- **Create** `apps/web/src/lib/destructive-save.ts` — `confirmDestructive({ preview, label })` helper: pretty-prints the preview, calls `useUi().confirm`, returns a boolean.
- **Modify** `apps/web/src/lib/api.ts` — extend `scripts.save`, `lowerThirds.save`, `recordings.replace` with optional `dryRun` flag.
- **Modify** `apps/web/src/pages/ScriptPage.tsx` and `apps/web/src/pages/ScenePage.tsx` (script tab) — wrap script save mutation with dry-run-then-confirm flow.
- **Modify** `apps/web/src/pages/LowerThirdsPage.tsx` — same wrap for LT save.
- **Modify** `apps/web/src/components/RecordingUpload.tsx` — same wrap for replace.

### Acceptance

- Saving an unchanged script (no chunks present) shows no dialog.
- Saving a script when chunks exist shows: *"This will discard 4 TTS chunks (~38s of audio) and 4 subtitle entries. Continue?"*
- Cancelling the dialog leaves storyboard untouched (verify by re-fetching).
- Lower-thirds save when bake exists shows: *"This will invalidate the baked overlay and the framed video. Continue?"*

### Commit

`feat(ux): warn before saves that discard downstream artifacts`

---

## Feature 2 — Project health rail

**Problem:** [apps/web/src/pages/ProjectOverview.tsx:1411](apps/web/src/pages/ProjectOverview.tsx:1411) `computeActionItems` already builds per-scene blockers — but only the Overview page sees them. Render-page scene strip ([apps/web/src/pages/RenderPage.tsx:87](apps/web/src/pages/RenderPage.tsx:87)) is only on Render. Script-fit is only inside the scene editor.

**Approach:** Extract `computeActionItems` + new `computeSceneHealth` into a shared module. Render a thin horizontal rail at the bottom of `ProjectWorkspace` (the route layout for `/project/:id/*`). Each scene = one chip, each chip = up to four mini dots {🎬 recording, ✍️ script-fit, 🔊 TTS fresh, ✨ render fresh}. Click a chip → navigate to that scene's relevant tab.

### Files

- **Create** `apps/web/src/lib/scene-health.ts` — pure function `computeSceneHealth(scene, projectMeasuredWpm)` returning `{ recording: 'ok'|'missing', script: 'fits'|'overrun'|'absent', tts: 'fresh'|'stale'|'missing', render: 'fresh'|'stale'|'missing' }`. Move `computeActionItems` here too; re-export from ProjectOverview.
- **Create** `apps/web/src/components/HealthRail.tsx` — fixed-position rail; reads storyboard from React Query cache (already-cached by parent route); compact 28-px-tall strip with scene chips.
- **Modify** `apps/web/src/pages/ProjectWorkspace.tsx` — mount `<HealthRail />` at the bottom of the workspace layout, behind a `localStorage` show/hide toggle (default on).
- **Modify** `apps/web/src/pages/ProjectOverview.tsx` — replace inlined `computeActionItems` with import from `scene-health.ts`.

### Acceptance

- Rail appears on every project page (Storyboard, Script, Narration, LT, Render, Review).
- Chip click on scene 3's "script overrun" dot navigates to `/project/<id>/storyboard?scene=<id3>&tab=Script`.
- Toggle (small ✕ on the right) hides the rail; preference persists across reload via `localStorage`.
- Rail does not appear on non-project routes (Dashboard, Brands, Voices, Setup).

### Commit

`feat(ux): persistent project health rail across phases`

---

## Feature 3 — Unified background-job tray

**Problem:** [apps/server/src/lib/job-queue.ts](apps/server/src/lib/job-queue.ts) tracks jobs but has no "list active jobs" API. Long ops (TTS batch, render, voice-clone) only show progress on the page that started them. Tab switch → user loses visibility.

**Approach:** Extend `jobQueue` with a `list({ activeOnly, projectId? })` method; new GET `/api/jobs` endpoint. Server tags jobs with `projectId` when relevant. Client adds a tray (collapsed by default in bottom-right) subscribing to one shared SSE stream OR polling `/api/jobs?active=1` every 2s for currently active jobs (start with polling — simpler, retire later if it matters).

### Files

- **Modify** `apps/server/src/lib/job-queue.ts` — add optional `meta: { projectId?, label? }` to `Job`; `create(type, meta?)`; `list({ activeOnly?, projectId? })`.
- **Modify** `apps/server/src/routes/jobs.ts` — GET `/api/jobs?active=1&projectId=...` returns `Job[]`.
- **Modify** call sites that create jobs (`narration.ts`, `render.ts`, `voice-clone.ts`, `music.ts`, `scene-render.ts`) — pass `projectId` and a human label (e.g. `"TTS: Scene 3 – paragraph 1"`).
- **Create** `apps/web/src/components/JobTray.tsx` — dockable tray; polls `/api/jobs?active=1` every 2s when expanded, every 5s when collapsed; renders job rows with progress derived from latest `progress` event in the job's events array.
- **Modify** `apps/web/src/lib/api.ts` — `jobs.listActive(projectId?)`.
- **Modify** `apps/web/src/App.tsx` — mount `<JobTray />` once at root, fixed bottom-right.

### Acceptance

- Start a batch TTS job on Narration page. Switch to LT page. Tray badge shows "1 running"; expanding reveals "TTS: 3 / 8 chunks".
- Tray collapses to a single 32-px round button with a count badge when no jobs active.
- Render started elsewhere visible from any project page.
- Tray hidden on non-project routes (Dashboard etc.) when no jobs are running.

### Commit

`feat(ux): unified background-job tray across phases`

---

## Feature 5 — Autosave state + snapshot history

**Problem:** Save-on-blur fires a toast *after* the user navigates away. No way to roll back a bad edit. [apps/server/src/services/storyboard/index.ts:23](apps/server/src/services/storyboard/index.ts:23) `saveStoryboard` is the single chokepoint for storyboard writes — a perfect place to hook snapshots.

**Approach:**
1. **Server:** every `saveStoryboard` call writes the previous YAML to `<project>/.snapshots/<iso-timestamp>.yaml`. Keep last 30 (oldest pruned). New endpoints: GET `/api/projects/:id/snapshots`, POST `/api/projects/:id/snapshots/:id/restore`.
2. **Client:** per-page "Saved Xs ago" / "Unsaved" / "Saving…" badge using existing `FieldStatus`/`SaveIndicator` infra. New History panel on Settings page (or a project-scoped one) lists snapshots, restore button calls confirm dialog.

### Files

- **Modify** `apps/server/src/services/storyboard/index.ts` — `saveStoryboard` reads current file, writes snapshot to `.snapshots/`, then atomically writes new. Helper `pruneSnapshots(root, keep=30)`.
- **Modify** `apps/server/src/services/project/paths.ts` — add `snapshotsDir: path.join(root, '.snapshots')`.
- **Create** `apps/server/src/routes/snapshots.ts` — GET list, POST restore (atomically copies snapshot YAML back to `storyboard.yaml` AND writes a fresh snapshot of the pre-restore state so restore is itself reversible).
- **Modify** `apps/server/src/server.ts` — register snapshot routes.
- **Create** `apps/server/src/services/storyboard/snapshots.ts` — write/list/prune/restore helpers, tested.
- **Create** `apps/web/src/components/SnapshotHistory.tsx` — list with timestamps + diff summary (scenes changed) + restore button.
- **Modify** `apps/web/src/pages/ProjectOverview.tsx` — add a "History" disclosure that mounts `<SnapshotHistory projectId={id} />`.
- **Modify** `apps/web/src/lib/api.ts` — `snapshots.list(id)`, `snapshots.restore(id, snapshotId)`.
- **Create** `apps/web/src/components/ui/LastSavedBadge.tsx` — small, page-mountable badge: reads `useIsMutating` like `SaveIndicator` but **also** shows the relative timestamp of last successful save on the current scope (e.g., "Saved 3s ago"). Stores `lastSavedAt` in a tiny context.
- **Modify** `apps/web/src/pages/ScenePage.tsx`, `ScriptPage.tsx`, `LowerThirdsPage.tsx`, `NarrationPage.tsx` — mount `<LastSavedBadge />` in each page header.

### Acceptance

- Editing a script and clicking Save creates a new file under `<project>/.snapshots/`.
- After 30 saves, oldest snapshot is pruned.
- History panel lists snapshots with timestamps and "3 scenes changed" summary.
- Clicking Restore on snapshot N writes a new snapshot of current state, then restores N. Confirmation dialog quotes what will change.
- Page header shows "Saved 4s ago" after a successful save; updates every second.

### Commit

`feat(ux): snapshot history and per-page last-saved badge`

---

## Verification checklist (final step)

- [ ] `npm run typecheck` clean
- [ ] `npm run lint` clean
- [ ] `npm run test` passes
- [ ] Dev server starts; manually exercise each feature in browser (preview tools)
- [ ] Screenshot each feature for PR description
- [ ] Open PR titled `feat(ux): global-state batch — destructive-save warnings, health rail, job tray, snapshot history`
