# Cap Agent Recording Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user review and copy a scene-specific recording brief that Codex can rehearse and execute with Computer Use while Cap records, then attach the exported MP4 through VPA's existing ingestion path.

**Architecture:** Shared schemas define persistent plans, transient sessions, and recording provenance. Fastify routes derive and save plans and manage a guarded session state machine. A repository skill is the executable handoff contract. The scene UI prepares and monitors the workflow without pretending to launch or control Codex.

**Tech Stack:** TypeScript, Zod, Fastify multipart routes, React, TanStack Query, Vitest, Playwright, Markdown Codex skill.

## Global Constraints

- macOS and Cap are the first provider; manual upload remains available.
- Record one scene at a time and rehearse before capture.
- Never persist Cap project paths in storyboard data.
- Never upload to Cap Cloud in this workflow.
- Never automate terminal applications or ChatGPT with Computer Use.
- Keep `ingestRecording` as the authoritative media-copy/probe/cache-invalidation path.

---

## Task 1: Define plans, sessions, and provenance

**Files:**
- Create: `packages/shared/src/agent-recording.ts`
- Modify: `packages/shared/src/storyboard.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/agent-recording.test.ts`

- [ ] Define `AgentRecordingPlanSchema` with server-owned scene identity, ordered actions, checkpoints, preconditions, capture settings, handles, failure policy, and attachment endpoint.
- [ ] Define a restricted editable payload that cannot change project/scene identity or the attachment target.
- [ ] Define session states and a public session schema that omits temporary local Cap paths.
- [ ] Extend recording metadata with backward-compatible `source_kind`, `capture_session_id`, and `captured_at` fields.
- [ ] Test defaults, editable-field restrictions, state values, and legacy recording compatibility.

## Task 2: Persist and serve reviewed recording plans

**Files:**
- Create: `apps/server/src/services/agent-recording/plan.ts`
- Create: `apps/server/src/routes/agent-recording.ts`
- Test: `apps/server/src/services/agent-recording/plan.test.ts`
- Test: `apps/server/src/routes/agent-recording.test.ts`
- Modify: `apps/server/src/index.ts`

- [ ] Derive a default plan from project objective, scene intent/type, and existing `shot_plan` actions.
- [ ] Default to a 1920×1080, 30 fps application-window capture with cursor on and mic/camera/system audio off.
- [ ] Store reviewed plans at `recording-plans/<sceneId>.json` with an input fingerprint so shot-plan changes are visible as stale.
- [ ] Implement GET for derived-or-saved plans and PUT for validated user-controlled changes.
- [ ] Verify project/scene ownership and write plan files atomically.
- [ ] Add route tests for derivation, persistence, restricted edits, stale input, and missing entities.

## Task 3: Add the recording-session state machine

**Files:**
- Create: `apps/server/src/services/agent-recording/session.ts`
- Modify: `apps/server/src/routes/agent-recording.ts`
- Test: `apps/server/src/services/agent-recording/session.test.ts`
- Test: `apps/server/src/routes/agent-recording.test.ts`

- [ ] Persist sessions under `recording-plans/sessions/` with generated IDs and timestamps.
- [ ] Allow only documented transitions among rehearsing, recording, exporting, attaching, completed, failed, and interrupted.
- [ ] Treat nonterminal sessions untouched for 30 minutes as interrupted when read.
- [ ] Implement create, update, and current-session GET routes scoped to the exact project and scene.
- [ ] Keep temporary Cap project/export paths server-side and redact/remove them after successful attachment.
- [ ] Test legal/illegal transitions, expiry, redaction, and cross-scene access rejection.

## Task 4: Attach Cap output through normal ingestion

**Files:**
- Modify: `apps/server/src/routes/recordings.ts`
- Modify: `apps/server/src/services/recordings/index.ts`
- Test: `apps/server/src/routes/recordings.test.ts`
- Test: `apps/server/src/services/recordings/index.test.ts`

- [ ] Accept validated provenance fields alongside the existing multipart scene upload.
- [ ] Require `capture_session_id` when `source_kind` is `cap-agent` and verify it belongs to the target scene.
- [ ] Pass provenance into `ingestRecording` while preserving metadata probing and derived-cache invalidation.
- [ ] Mark the session complete only after successful ingestion; failed uploads must not mutate the scene or claim completion.
- [ ] Invalidate canonical workflow status through the same client mutation lifecycle as manual upload.
- [ ] Cover manual compatibility, valid Cap attachment, mismatched sessions, and failed ingestion.

## Task 5: Add the repository Codex handoff skill

**Files:**
- Create: `.agents/skills/vpa-agent-recording/SKILL.md`
- Create: `.agents/skills/vpa-agent-recording/references/handoff-template.md`
- Create: `scripts/check-agent-recording-skill.mjs`
- Modify: `package.json`

- [ ] Teach the skill to fetch and validate the exact plan and register a rehearsal session.
- [ ] Require `cap guide --json`, `cap doctor --json`, and `cap targets --json` before selecting flags or targets.
- [ ] Require supported-target validation, rehearsal checkpoints, reset, and explicit confirmation of target plus audio/camera settings before recording.
- [ ] Require detached start, exact-session stop, stop metadata, Cap project validation, local MP4 export, VPA attachment, and response verification.
- [ ] Stop without attachment on checkpoint failure, unsupported terminal/ChatGPT target, invalid Cap project, or export failure.
- [ ] Explicitly prohibit Cap Cloud upload and automatic Cap installation.
- [ ] Add a static contract check for the safety-critical requirements and wire it into repository checks.

## Task 6: Build the scene preparation and monitoring UI

**Files:**
- Create: `apps/web/src/components/AgentRecordingDialog.tsx`
- Create: `apps/web/src/components/AgentRecordingStatus.tsx`
- Modify: `apps/web/src/pages/ScenePage.tsx`
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/styles.css`
- Test: `apps/web/e2e/agent-recording.spec.ts`

- [ ] Place `Record with Codex` beside manual upload/replace actions.
- [ ] Display editable target, starting URL, action steps, checkpoints, capture settings, readiness checklist, and `Rehearse first` enabled by default.
- [ ] Clearly warn that terminal and ChatGPT targets are unsupported; disable handoff for those targets.
- [ ] Save the reviewed plan before generating handoff text.
- [ ] Copy a concise prompt containing the exact plan URL, project/scene identity, and repository skill name; do not claim Codex was launched.
- [ ] Show waiting/progress state only after an actual session exists, polling until a terminal state.
- [ ] Keep manual upload available in every state and refresh the scene plus workflow status after completion.
- [ ] Add E2E coverage for plan derivation, save/copy, unsupported target, session display, and manual fallback.

## Task 7: Document and verify the real workflow

**Files:**
- Modify: `README.md`
- Create: `docs/agent-recording-cap.md`
- Modify: `docs/superpowers/specs/2026-07-31-cap-agent-recording-design.md` only if implementation details legitimately changed.

- [ ] Document prerequisites, permissions, preparation, rehearsal, confirmation, export, attachment, privacy defaults, and failure recovery.
- [ ] Document that VPA prepares the handoff and does not programmatically start Codex.
- [ ] Run shared/server/web tests after the end-to-end slice is complete.
- [ ] Run the skill contract check and the Cap fake-backed Playwright test.
- [ ] Run the full repository test, typecheck, and lint commands.
- [ ] Perform one manual macOS browser-scene rehearsal/record/export/attach acceptance run when Cap is installed; otherwise document it as an explicit external acceptance step without claiming it passed.
- [ ] Inspect `git diff --check` and review that no secrets, Cap Cloud upload, or persistent local Cap paths were introduced.
