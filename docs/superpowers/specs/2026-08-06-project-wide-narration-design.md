# Project-wide narration generation

## Summary

VPA will let a user choose one TTS engine, voice, speed, and emotiveness on the
project Narration page and generate narration audio across every eligible scene
without opening each scene individually.

The operation is audio-only. It never writes, drafts, repairs, or otherwise
invents a script. A scene whose active narration script is empty is skipped and
reported as `No script`.

Generation runs as one server-managed job. The server processes scenes in
storyboard order, continues after bounded per-scene failures, and exposes
progress and cancellation through the existing job stream. This keeps the work
alive when the browser navigates away and avoids provider rate-limit spikes.

## Goals

- Select an available TTS engine and one of its voices once for the project.
- Select speed and the existing project emotiveness setting in the same panel.
- Generate audio for every scripted scene in storyboard order.
- Skip scenes with no active script without calling an LLM or TTS provider.
- Preserve current narration by default.
- Offer an explicit `Overwrite existing narration` checkbox to regenerate
  scripted scenes that already have audio.
- Preserve explicit dialog speaker voice assignments.
- Show an eligibility preview, live progress, cancellation, and a useful final
  summary.
- Refresh narration status, scene durations, workflow state, and render
  readiness when the job changes project assets.

## Non-goals

- Generating or modifying scripts.
- Generating narration for an empty-script scene from slide text, scene
  description, recordings, or other context.
- Replacing explicit dialog speaker assignments with the project-selected
  voice.
- Parallel generation across scenes.
- A general multitrack audio timeline.
- Persisting a new global account-level voice preference.
- Rolling back audio that completed before a later scene failed or the user
  cancelled.

## User experience

### Project narration panel

The existing project Narration page gains a `Narrate project` panel above the
scene list. It contains:

- **Engine**: populated from `GET /api/tts/engines`.
- **Voice**: populated from the selected engine, including registered custom
  voices.
- **Speed**: the same supported range and default used by scene narration.
- **Emotiveness**: the existing light, medium, and heavy project default.
- **Overwrite existing narration**: unchecked by default.
- A live eligibility sentence such as: `8 scenes will be narrated · 2 existing
  narrations preserved · 3 skipped without scripts`.
- A primary **Narrate project** button.

Changing engine resets the selected voice to that engine's first available
voice. The button is disabled when no engine/voice is available, no scene is
eligible, a project narration job is active, or the storyboard has not loaded.

The first release does not add new persistent engine, voice, or speed fields to
the storyboard. The selection is an instruction for the current project job.
Emotiveness continues to persist through the existing storyboard default.

### Eligibility and overwrite rules

The server is authoritative. The browser preview is explanatory and may become
stale before the job reaches a scene.

For each scene, immediately before processing it, the server reloads the
current storyboard and applies these rules:

1. If the scene no longer exists, record it as skipped and continue.
2. If its active narration script is empty after trimming, record `No script`
   and continue without model or TTS calls.
3. With overwrite unchecked, generate only missing, failed, or stale chunks.
   A current complete narration is preserved.
4. With overwrite checked, regenerate all chunks for every scripted scene.
5. In dialog mode, an explicit per-speaker engine/voice/speed assignment wins.
   The project selection applies only where a speaker override is absent.

An imported PDF deck therefore gets one-click audio generation only for slides
whose narration scripts already exist. Slides without scripts remain silent.

### Progress and completion

While running, the panel becomes a progress surface showing:

- Current scene name and storyboard position.
- Completed, failed, preserved, and no-script counts.
- Overall progress based on the initial ordered scene set.
- A **Cancel** button.

Cancellation uses the existing job cancellation route. The current
`generateAllChunks` call observes cancellation at chunk boundaries; no new
scene starts after cancellation. Audio already written remains valid.

The terminal summary distinguishes:

- Completed with all eligible scenes successful.
- Completed with some scene failures.
- Cancelled.
- No eligible work.

Failures show bounded user-safe guidance and never expose provider responses,
API keys, filesystem paths, or raw exception text.

## Server design

### Endpoint

Add:

`POST /api/projects/:id/narration/generate-project`

Request:

```json
{
  "engine": "xai",
  "voice": "Ara",
  "speed": 1,
  "expressiveness": "medium",
  "overwrite": false
}
```

Validation is strict. The server requires a known engine, a voice offered by
that engine, a supported finite speed, a valid expressiveness value, and a
boolean overwrite value. Unknown properties are rejected.

Response:

```json
{
  "jobId": "...",
  "status": "running"
}
```

Only one active project narration job may own a project at a time. A second
request returns `409 narration_job_active` with a bounded message.

### Orchestration

Create a focused project narration orchestrator rather than placing the loop
inside the route. It receives the project, validated options, TTS service,
model router, workspace root, progress callback, and cancellation callback.

The orchestrator snapshots ordered scene IDs for progress accounting, then
processes them sequentially. Before each scene it reloads the storyboard,
re-evaluates the current script and audio, and delegates chunk work to the
existing `generateAllChunks` service with selector `missing` or `all`.

It resolves the writing model only when the exact target batch requires it,
including xAI expressiveness processing or explicit dialog speaker overrides.
Empty-script and preserved scenes never resolve a writing model or call TTS.

An individual scene failure is converted to a bounded result and the loop
continues. Project lookup, invalid request data, missing engines/voices, or job
ownership conflicts fail before the job starts.

### Job result

The completed job result contains bounded identifiers and counts:

```json
{
  "totalScenes": 13,
  "generatedScenes": 8,
  "generatedChunks": 22,
  "preservedScenes": 2,
  "noScriptScenes": 3,
  "failedScenes": 0,
  "cancelled": false,
  "failures": []
}
```

`failures` is capped and contains scene ID, scene name, and a stable public
reason code only.

## Client design

Extend the typed narration API with `generateProject`. Reuse the existing job
stream and cancellation APIs.

The Narration page owns the panel state. It derives the explanatory preview
from the current storyboard, but renders server progress and terminal counts
once a job begins. Completion, partial failure, and cancellation invalidate:

- `['storyboard', projectId]`
- every affected scene's narration query
- project workflow status
- active jobs
- render/readiness queries used by the project shell

The scene list remains available below the panel for inspection and manual
per-scene correction.

## Error handling

- Invalid engine/voice/options: reject before job creation.
- Active project narration job: return 409; preserve the active job.
- Scene removed or script cleared during the run: skip safely.
- Provider or chunk failure: mark the scene/chunk through existing narration
  behavior, count the scene as failed, and continue.
- Browser disconnect: server job continues.
- Server restart: active in-memory jobs do not resume; already written audio
  remains. The next run re-evaluates missing/stale chunks and can continue.
- Cancel: stop at the next chunk boundary and retain completed audio.

## Accessibility and responsive behavior

- Every select and checkbox has a visible label.
- Progress uses an `aria-live="polite"` summary rather than announcing every
  chunk event.
- Failure summary uses `role="alert"` only at the terminal boundary.
- Keyboard focus remains on the project action after completion; cancellation
  returns focus to the primary action.
- Controls wrap into a single column on narrow screens without horizontal
  scrolling.

## Testing

Server tests cover:

- Strict request validation and engine/voice validation.
- One active project job per project.
- Storyboard-order sequential generation.
- Empty scripts skipped with zero model/TTS calls.
- Existing complete audio preserved by default.
- Missing, failed, and stale chunks generated by default.
- Overwrite regenerates all scripted scenes.
- Explicit dialog speaker assignments preserved.
- Scene removal and script clearing during a run.
- Per-scene failure continuation and bounded failure output.
- Cancellation between chunks/scenes.
- No provider calls when there is no eligible work.

Client tests cover:

- Engine/voice dependency and disabled states.
- Eligibility counts.
- Overwrite unchecked by default.
- Starting, progress, cancellation, completion, and partial failure.
- Query invalidation after terminal events.
- Responsive and keyboard-accessible controls.

An isolated browser test creates a project with scripted, unscripted, and
already narrated scenes; runs project narration with a deterministic provider;
verifies the skip/preserve rules; then runs with overwrite enabled and verifies
that scripted scenes are regenerated while the unscripted scene remains
untouched.

## Rollout

This is an additive project-level workflow. Existing scene narration routes,
audio formats, stored chunks, manual edits, and render behavior remain
compatible. The per-scene controls remain the detailed correction path.
