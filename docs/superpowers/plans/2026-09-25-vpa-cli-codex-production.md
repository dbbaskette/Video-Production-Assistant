# VPA CLI and Codex Production Skill Implementation Plan

## Contract

Implement the approved design in `docs/superpowers/specs/2026-09-25-vpa-cli-codex-production-design.md`. This is the first deliverable of #89 under roadmap #88, not an attempt to absorb all dependent roadmap issues.

## Slice 1 — Truthful narration discovery

**Files:** `apps/server/src/services/tts/provider.ts`, provider implementations, `apps/server/src/services/tts/index.ts`, narration route tests, web API types.

- Add provider-owned capability metadata.
- Return readiness and capabilities from `/api/tts/engines` without exposing secrets.
- Make xAI's adapter send its advertised native speed.
- Verify engine discovery literals and backward-compatible fields.

**Acceptance:** discovery and actual provider behavior share speed constraints; current browser consumers compile unchanged.

## Slice 2 — Validated standalone narration API

**Files:** `apps/server/src/routes/tts-scratch.ts`, route tests, voice-profile service usage.

- Resolve optional profiles and explicit overrides.
- Validate engine, voice, speed, expressiveness, and text size before synthesis.
- Persist and return effective settings and a stable audio endpoint.
- Preserve the existing request shape.

**Acceptance:** fake-provider tests generate a persisted playable fixture; invalid selections do not invoke TTS.

## Slice 3 — CLI package

**Files:** new `apps/cli/`, root `package.json`, TypeScript project references if required.

- Implement argument parsing, HTTP client, structured output, error codes, narration discovery/create/project commands, project inspection, and job show/wait.
- Use `VPA_API_URL` with a localhost default.
- Download standalone audio only after successful artifact creation.
- Add hermetic CLI tests against a disposable local HTTP server or injected fetch boundary.

**Acceptance:** command tests cover discovery, profile resolution handoff, audio download, project job start/wait, invalid arguments, API errors, and connection errors.

## Slice 4 — Codex skill and documentation

**Files:** new `.agents/skills/vpa-production/SKILL.md`, optional agent metadata, README or automation documentation.

- Document discovery-first narration and project workflows.
- State overwrite, fallback, credential, job, and artifact-verification boundaries.
- Ensure examples use commands verified by CLI help/tests.

**Acceptance:** repository skill is discoverable and a static consistency check confirms named commands remain present in CLI help.

## Integrated verification owner

The primary implementation session owns:

- targeted tests after each coherent slice;
- full relevant workspace tests once after integration;
- root build and typecheck;
- a local fake-provider smoke test using `start.sh` and the CLI, with no paid provider calls;
- final diff review against the specification and explicit reporting of staged #89 work not included in this slice.

## Risks

- Provider capabilities can drift from actual behavior. Keep metadata adjacent to provider adapters and assert important bounds in provider tests.
- CLI output can accidentally mix logs with JSON. Route all machine output through one renderer and errors through stderr.
- Profile defaults can hide choices. Return effective engine/voice/speed in results and let explicit flags override profiles.
- Existing tests may rely on exact engine objects. Update compatibility fixtures without removing prior fields.
- The in-memory job queue is not cross-restart durable; do not claim #99 semantics in this slice.

## Completion record

- [x] Slice 1 complete
- [x] Slice 2 complete
- [x] Slice 3 complete
- [x] Slice 4 complete
- [x] Integrated verification complete
