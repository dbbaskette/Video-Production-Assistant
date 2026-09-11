# VPA workspace stabilization implementation plan

Goal: complete approved issues #117/#118 and #113 → #112 → #114, preserving existing project media and production tools.

Architecture: keep the existing React/Fastify services and scene model. Mount one scene preview independently of inspector navigation. Reuse existing thumbnails, workflow status and narration providers; keep source/composed preview distinctions explicit. No new revision engine or browser recording is part of this change.

Spec: GitHub issues #112, #113, #114, #117, #118 and the September 11 live audit in DemoForge.

1. Stabilization: normalize actual Cap targets (nested physicalSize/bounds as well as legacy flat fields), preserve strict invalid-data checks, explain discovery failures and unsupported workflow controls. Correct creation hints, brand back link, optional-stage progress and no-op narration. Test runtime fixtures, workflow status and narration eligibility.
2. #113: keep ScenePreview mounted outside conditional inspectors; use URL-derived tab state for browser history. Add source thumbnail rows with contextual actions. Move script generation under disclosure after existing text. Consolidate project navigation while retaining existing deep routes/batch tools. Validate tab switching does not remount preview, back/forward, missing media and slide duration behavior.
3. #112: lead overview with current video or scene preview and next action, brief, compact source links; move routing/path/export-source details under project settings. Add project-list thumbnails/status; hide advanced directory settings. Verify empty/partial/complete states, search/sort and creation modes.
4. #114: share a voice-preset picker between scene and batch generation; retain explicit custom provider settings in disclosure, effective voice/affected/preserved summaries, granular regeneration, and remote-only voice guidance. Test presets, overrides, no-op batches and errors.
5. Run targeted milestone tests, full relevant suite, typecheck/build and live browser review. Commit coherent increments and publish reviewable branch/PR with issue evidence. Do not close partially fulfilled issues or claim a live recording/render was tested when only preflight was exercised.

Design: preserve the existing theme tokens and typography. Spend screen space on the media; use a compact scene rail and a persistent preview beside a scrollable inspector on wide screens, stacked on narrow screens. Reduce repeated bordered cards and provider detail in the primary flow. Existing user authorization covers these issue designs; no further design approval gate is needed.

## Implementation and verification

Implemented in the approved order: persistent scene workspace (#113), project home and creation (#112), then effective voice and batch controls (#114), alongside Cap/setup stabilization (#117/#118). Existing deep routes, source media, granular regeneration, retry and cancellation are retained. Existing visual brand overview remains primary; manual brand editing stays in #86/#28.

- Shared suite: 43 passed.
- Server suite: 1,143 passed, one existing skipped test.
- Final full web suite: 255 passed. An initial assertion incorrectly expected a cached audio URL to disappear during silence; the corrected test checks that playback does not start in the gap.
- Production build (including TypeScript compilation): passed, existing large-bundle warning remains.
- Lint: full repository has pre-existing failures, including worktree copies. Compared modified files with the base commit: no new diagnostics.
- Live browser: current export and timestamp on home, collapsed project settings, a 16-scene thumbnail rail, an eight-second slide preview, playback retained at four seconds after switching to Script, script before generation controls, failure-first setup with healthy checks collapsed.
- Live review exposed thumbnail extraction seeking beyond a one-second source; corrected to seek within short recordings and at zero for slides.
- No paid model calls, live capture, source replacement or dependency installation were used for verification. Missing drawtext remains a local environment condition and is now explained at affected render actions.

The implementation branch is based on the existing progress/cancellation branch (PR #87); its PR must follow #87 into main. Export version display uses existing timestamps/freshness, not a new revision-history backend.
