# Visual effects and source evidence design

## Goal

Close #94 and #95 with one source-time model shared by the UI, revision commands, preview, rendering, captions, and Codex-facing HTTP APIs. Immutable media is never rewritten.

## Contracts

- A visual effect is a strict discriminated union. Every timed effect names a clip instance, immutable source asset, source interval, and normalized source-space geometry. Text, arrows, highlights, opaque redaction, zoom, background, camera layout, logo, title, and lower-third presets are bounded; arbitrary filter/script payloads are impossible.
- The fixed render order is source → redaction → source annotations → zoom → background/frame → camera → logo/title → captions. Unsupported capabilities fail before rendering.
- A transcript is an English word-aligned analysis of an immutable asset. It includes word start/end, optional confidence/speaker, Gemini model provenance, settings hash, source hash, and analyzed coverage. Corrections replace text only and preserve timing.
- Transcript words map through trims, reorders, and duplicate clip instances. SRT and burn-in consume the same mapped words.
- Evidence items name their asset and source time. Frames, contact sheets, and bounded excerpts are cached under a fingerprint containing the asset hash and settings.

## UX

The project Lower Thirds page becomes the visual/evidence workspace while retaining the existing scene summary. A scene editor provides a persistent source preview, direct **Add text**, one selected inspector, a zoomable/range-focused timeline, overlap warnings, drag positioning plus numeric keyboard alternatives, explicit save state, and navigation protection. Transcript search, word correction, denser uncertainty inspection, selected frames, contact sheet, and excerpts sit beside the same source clock.

## Failure and compatibility

Existing lower thirds, narration subtitles, accepted assets, and renders remain valid. Analysis failure does not modify the storyboard. Changing the source hash/model/settings makes cached analysis stale. Redaction is visibly labeled as a derived effect; originals remain unredacted. Moving content requires additional masks rather than claiming automatic tracking.

## Verification

Schema tests reject invalid geometry, timing, clip/asset mismatches, and script-like payloads. Mapping tests cover pauses, speaker changes, trim/reorder/duplicate, corrections, and SRT agreement. Renderer tests assert fixed stage order, opaque masks, non-landscape coordinates, boundaries, and caption/camera safe-area behavior. Route/service tests cover provenance, stale caches, provider failure, frames/contact sheets/excerpts, and preservation of prior accepted state. Component tests cover first manual overlay, shared selection, overlap/missing-duration states, dirty navigation, and save payloads.
