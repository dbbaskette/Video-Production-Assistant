# Workflow Status and Render Readiness Design

## Summary

Replace VPA's duplicated, sometimes contradictory progress indicators with one canonical project-status model. The same model will drive the project sidebar, overview, issues drawer, and render preflight. A finished video will be considered complete only when it was produced from the current project inputs; an existing but outdated `final.mp4` will be shown as stale.

This work implements UX improvements 1–4 from the application review:

1. trustworthy progress states;
2. render preflight and error prevention;
3. consolidated project status;
4. replacement of the bottom health rail.

## Goals

- Give every screen the same answer to “What should I do next?”
- Distinguish missing, ready, in-progress, complete, and stale work.
- Prevent a “full project” render when required recordings are missing.
- Make warnings actionable without permanently covering page content.
- Preserve optional narration, lower thirds, music, frames, and brand assets.
- Keep all status computation testable outside React components.

## Non-goals

- Redesign every phase page.
- Require optional narration or lower thirds before rendering.
- Support partial-project final renders in this iteration. Per-scene preview remains the supported way to review incomplete projects.
- Treat Quality Review warnings as hard render blockers.
- Delete stale render files automatically.

## Canonical status model

Add a server-side `workflow-status` service and a shared response schema. React components will stop independently deriving workflow completion from cached API responses.

Each workflow step has one state:

- `blocked`: a required upstream input is missing.
- `ready`: this is the next actionable step.
- `in_progress`: some, but not all, required work exists.
- `complete`: the step's required output is current.
- `stale`: output exists but an upstream input changed after it was produced.
- `optional`: the step may be skipped and has no current work.

Required-step rules are explicit: Storyboard is complete when at least one scene exists; Recordings are complete when every scene has a valid recording; Render is complete only when a current full-project output exists; Quality Review is complete only when its saved input fingerprint matches the current review inputs. Script, Narration, and Lower Thirds are optional: they are `optional` when unused and `in_progress` when used by only part of the project, but they never block Render. The next action is the earliest incomplete required step, followed by Render and then Quality Review. Optional-step warnings can override that action only when the user has already opted into the feature and its generated output is stale or invalid.

The endpoint `GET /api/projects/:id/workflow-status` returns:

- ordered workflow steps with state, summary, completed count, and total count;
- a single next action;
- project issue counts and scene-specific issue records;
- render readiness, blockers, warnings, and output freshness;
- the timestamp when the status was computed.

UI route construction remains client-side. The server returns semantic keys such as `recording_missing` and scene IDs rather than React URLs.

## Render freshness

The current `render/status` endpoint treats the presence of `renders/final.mp4` as completion. Replace that rule with a render manifest stored at `renders/render-manifest.json` after a successful render.

The manifest contains:

- schema version;
- completion timestamp;
- output path, size, duration, and rendered scene count;
- the render options used;
- a SHA-256 project-content fingerprint.

The project-content fingerprint includes only render-affecting inputs:

- ordered scene IDs;
- recording paths plus file size and modification time;
- narration scripts, chunk configuration, audio paths, and audio file metadata;
- lower-third data;
- transitions and durations;
- scene and project frame settings;
- selected project music and file metadata;
- applied brand ID/version and referenced bumper, music, logo, or design assets;
- render defaults that affect output.

Freshness checks reuse the options stored in the last render manifest to resolve the exact music and brand assets used by that render. Merely changing unsaved controls on the Render page does not make an existing output stale; starting a new render records the new options.

Derived cache fields such as `overlay_render` and `frame_render`, review results, chat transcripts, and shot-plan text are excluded. This prevents the renderer's own cache writes from making a newly completed render immediately stale.

Status rules:

- No output: `missing`.
- Output without a manifest: `stale` with the explanation “Rendered before freshness tracking was added.”
- Output and matching fingerprint: `complete`.
- Output and mismatched fingerprint: `stale`.
- Active render job: `in_progress`.

The stale file remains playable and downloadable, but its UI is visually labelled as outdated and offers “Render again.”

Quality Review receives a parallel review-input fingerprint when a review is saved. It covers the storyboard fields and source documents read by the reviewer while excluding derived render caches. A missing legacy fingerprint or a mismatch produces the `stale` review state.

## Render preflight

Add a reusable preflight function used by both `GET /workflow-status` and `POST /render`.

Hard blockers:

- no storyboard;
- storyboard with zero scenes;
- any scene missing a recording;
- a referenced recording file does not exist or cannot be probed;
- another full-project render is already running.

Warnings are option-aware and do not block rendering:

- narration is enabled but only some scenes have generated narration;
- lower thirds are enabled but only some scenes contain them;
- subtitles are enabled but subtitle data is incomplete;
- an applied brand asset is referenced but unavailable;
- Quality Review is stale, unrun, or contains warnings.

The render page shows a preflight panel above the output options. It lists the number of ready scenes, blockers, and warnings with links to the relevant scene or phase. “Render full project” is disabled while blockers exist.

`POST /api/projects/:id/render` recomputes preflight on the server. If blockers exist, it returns HTTP 409 with `code: render_blocked` and the structured blocker list. The UI never relies solely on a previously fetched preflight result.

## Project overview

Replace the large pipeline card plus separate “Needs attention” card with one compact project-action card:

- project progress summary;
- the next action and one primary button;
- a compact seven-step status row;
- blocker and warning counts;
- up to three highest-priority issues;
- “View all issues” to open the issues drawer.

Reference materials, Brand, Per-scene workflow, and History remain below the action card. The project path is de-emphasized so operational status is the first content users see.

The sidebar continues to show workflow order but only uses compact state markers and the `Next` label. It consumes the canonical endpoint and does not recompute state.

## Project issues drawer

Remove the sticky bottom `HealthRail`. Replace it with a compact “Project issues” control in the project workspace header area. It shows blocker and warning counts and does not cover content.

Opening the control reveals a right-side drawer containing:

- Blockers first, then warnings.
- Grouping by workflow phase.
- Scene number and name.
- Plain-language problem and recommended action.
- A deep link to the exact scene tab or phase page.

The drawer is keyboard accessible, traps focus while open, closes with Escape, and restores focus to its trigger. On narrow screens it becomes a full-width sheet. When the project has no issues, the control reads “Project ready” and the drawer is not opened automatically.

The same issue records populate the overview's three-item preview. There is no second issue-computation path.

## Data flow

1. A UI route requests `workflow-status` through React Query.
2. The server loads the project, storyboard, render manifest, review, and relevant file metadata.
3. The workflow service computes step states, issues, preflight, and render freshness.
4. Sidebar, overview, issues drawer, and render page render different views of the same response.
5. Mutations invalidate the `workflow-status` query in addition to their existing domain queries.
6. Render completion writes the manifest before reporting the job as complete, then invalidates status.

## Error handling

- Missing optional files become warnings; missing required recordings become blockers.
- A corrupt or unreadable manifest makes the output stale rather than crashing status pages.
- A fingerprint failure returns a degraded status with an actionable warning and logs the underlying error.
- A preflight race is handled by the server-side 409 response.
- Status pages retain their last successful data during refetch to avoid navigation flicker.

## Testing

### Unit tests

- State transitions for empty, partial, complete, and stale projects.
- Optional steps do not block the next required action.
- Fingerprints are stable when derived cache fields change.
- Fingerprints change for recordings, narration, transitions, music, frame settings, and brand inputs.
- Legacy output without a manifest is stale.
- Preflight blocker and warning classification.

### Route tests

- `workflow-status` response schema and not-found behavior.
- Render route returns 409 for incomplete recordings.
- Successful render writes a manifest and reports a current output.
- Corrupt manifest degrades to stale output.

### Component and E2E tests

- Sidebar and overview show identical step states.
- Project action card deep-links to the next action.
- Issues drawer opens, groups issues, deep-links correctly, and supports Escape/focus restoration.
- Bottom health rail is absent.
- Render button is disabled with blockers and enabled when every scene is recorded.
- Changing an upstream input changes the output label from complete to stale.

## Rollout order

1. Shared schemas and workflow-status service.
2. Render manifest and server-side preflight enforcement.
3. Client API and query invalidation.
4. Sidebar and overview consolidation.
5. Issues drawer and HealthRail removal.
6. Render preflight UI and E2E coverage.
