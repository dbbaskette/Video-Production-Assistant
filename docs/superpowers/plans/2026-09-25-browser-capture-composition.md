# Browser Capture and Non-Destructive Composition Implementation Plan

## Contract

Implement `docs/superpowers/specs/2026-09-25-browser-capture-composition-design.md` and close #92 and #93 as one independently shippable capture/editing group.

## Slice 1 — Shared capture and composition contracts

**Files:** shared capture/composition modules, storyboard/command/job exports, schema/helper tests.

- Define bounded capture session, track, chunk acknowledgement, clip instance, linked-track, and audio-mix schemas.
- Add composition duration/timeline normalization helpers using integer milliseconds.
- Extend revision commands with initialize/trim/split/delete/reorder/duplicate/mix operations.

**Verification:** invalid bounds/IDs/roles/MIME types fail; duplicate source use remains valid through distinct instance IDs; normalization is deterministic.

## Slice 2 — Durable browser capture backend

**Files:** project paths, new browser-capture service/routes, server registration, asset-store media overrides, service/route tests.

- Persist session state before accepting chunks.
- Atomically store and acknowledge bounded ordered chunks with checksum idempotency.
- Reclassify interrupted sessions, validate contiguous tracks, assemble and probe media, then import immutable assets.
- Attach completed tracks to the target scene through an accepted revision command batch.

**Verification:** duplicate/conflicting chunks, gaps, restart, incomplete upload, malformed media, service failure, and multi-track common-clock metadata.

## Slice 3 — Explicit browser capture UI

**Files:** browser capture controller/component, Recordings page/API, component/controller tests.

- Add Prepare → preflight → Start/countdown → recording/elapsed → Stop workflow.
- Detect MIME support and actual shared audio; offer optional microphone/webcam.
- Upload each track serially, surface durable acknowledgement state, and list/recover incomplete takes.
- Release all streams on stop/cancel/error/unmount and enforce the 20-minute ceiling.

**Verification:** no media API before user action, permission denial, device/source end, recorder error, cancellation, cleanup, background event handling, and capability fallbacks.

## Slice 4 — Revision-backed editing and compact UI

**Files:** revision store/commands routes, composition service/API/editor, tests.

- Initialize compositions from immutable scene sources.
- Implement atomic linked trim/split/delete/reorder/duplicate and bounded audio-mix commands.
- Add ordered clip blocks, timing handles/fields, edit buttons, and a small role-based mixer.

**Verification:** stale revision, invalid edit rollback, split math, new duplicate IDs, linked-track preservation, restore, and UI command payloads.

## Slice 5 — Shared composition render path

**Files:** composition materializer, project and per-scene render integration, render tests.

- Materialize trimmed/reordered clips and linked audio lanes to a derived scene input.
- Apply gain, mute and fixed fades for original/system, microphone, camera, narration, and music without doubling recorded speech.
- Reuse the same duration/inclusion plan for UI preview metadata and both render entry points.

**Verification:** microphone-only, original-plus-narration, absent shared audio, silent lanes, music boundaries, fades/gain, repeated assets, and source-byte checksum preservation.

## Slice 6 — Pilot boundary and integrated verification

- Add capability copy and a manual matrix for Chrome/Edge on macOS/Windows at up to 1080p/30 and 20 minutes.
- Confirm native upload and Cap assets initialize the same composition model.
- Run build, typecheck, full tests, changed-file lint, and diff audit; publish, inspect CI, and merge before starting the next P1 group.

## Completion record

- [x] Slice 1 complete
- [x] Slice 2 complete
- [x] Slice 3 complete
- [x] Slice 4 complete
- [x] Slice 5 complete
- [x] Slice 6 complete — automated checks pass; the physical OS/browser release matrix remains documented for pilot sign-off.
