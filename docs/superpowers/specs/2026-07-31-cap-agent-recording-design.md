# Cap Agent Recording Design

> **Superseded in part:** [VPA-Managed Cap and Codex CLI Integration Design](2026-07-31-vpa-cap-codex-integration-design.md) replaces this document's clipboard handoff, Codex Computer Use, direct agent-owned Cap lifecycle, and browser-authored session-update sections. The reviewed-plan, provenance, ingestion, manual-upload, and local-only safety foundations remain current.

## Summary

Add a macOS-first, Cap-backed workflow for recording individual VPA scenes with Codex. VPA supplies a structured and reviewable recording plan. Cap's CLI controls capture. Codex Computer Use drives the target browser or desktop application. The resulting MP4 is attached through VPA's existing recording-ingestion route so metadata extraction and cache invalidation remain authoritative.

The workflow records one scene at a time with human review before capture. It does not attempt unattended whole-storyboard recording in the first iteration.

## Goals

- Turn an existing scene intent and shot plan into an executable recording brief.
- Rehearse the UI flow before recording the final take.
- Use Cap's structured CLI lifecycle rather than automate Cap's UI.
- Let Codex drive supported browser and desktop applications with Computer Use.
- Validate and attach the exported MP4 to the correct scene.
- Make capture provenance and failure state visible in VPA.
- Preserve manual upload as a first-class fallback.

## Non-goals

- Bundle, fork, or embed Cap source code.
- Start Codex programmatically from VPA.
- Automate terminal applications or ChatGPT itself.
- Upload recordings to Cap Cloud by default.
- Record multiple scenes in one unattended run.
- Add ShareX support in the first iteration.
- Add OBS support before the Cap workflow is validated with real projects.

## Why Cap first

Cap provides an official agent-oriented CLI, skill, and local MCP. Its recording lifecycle exposes capture readiness, target discovery, detached start, exact-session stop, project validation, and local export. This is more deterministic than driving a recorder's buttons with Computer Use.

ShareX remains a possible Windows adapter but is not appropriate for the macOS-first MVP. OBS is the preferred future cross-platform provider because its WebSocket API can control recording without UI automation.

## Architecture

The implementation has four bounded parts.

### 1. Recording plan service

Add shared `AgentRecordingPlan` schemas and a server service that derives a plan from the project and scene.

The plan contains:

- version, project ID/name, and scene ID/name/type;
- scene intent and project objective;
- ordered steps from `shot_plan`;
- target application and optional starting URL supplied by the user;
- capture target preference: window by default, screen only when explicitly selected;
- fixed output dimensions and frame rate;
- cursor, microphone, camera, and system-audio choices;
- preconditions and expected checkpoints;
- two-second lead-in and tail handles;
- failure policy: stop, retain diagnostics, do not attach;
- VPA attachment endpoint and expected success response.

`GET /api/projects/:id/scenes/:sceneId/agent-recording/plan` returns the derived plan. `PUT` accepts only user-controlled capture settings, preconditions, checkpoints, and step refinements; project and scene identity are server-owned.

Plans are persisted under the project at `recording-plans/<sceneId>.json`. This makes the reviewed instructions stable during the Codex handoff and allows the UI to show when the underlying shot plan has changed.

### 2. Scene recording UX

Add “Record with Codex” next to the existing upload/replace recording action.

The preparation dialog shows:

- target app/window and optional starting URL;
- ordered actions and checkpoints;
- capture settings;
- a readiness checklist;
- an explicit note that terminal and ChatGPT windows cannot be driven by Computer Use;
- “Rehearse first” enabled by default;
- “Copy Codex handoff” as the primary action.

The handoff text identifies the local VPA endpoint and instructs Codex to use the repository's VPA recording skill. VPA does not claim that Codex has started; the UI changes to “Waiting for recording” only after a recording session is registered.

The dialog also provides “Upload manually” at all times.

### 3. Repository Codex skill

Add a project skill at `.agents/skills/vpa-agent-recording/SKILL.md`. It teaches Codex to:

1. Fetch and validate the exact VPA recording plan.
2. Check Cap with `cap guide --json`, `cap doctor --json`, and `cap targets --json` rather than guessing flags.
3. Verify the target application is supported by Computer Use.
4. Rehearse the plan without recording and verify every checkpoint.
5. Reset the target application to the defined starting state.
6. Show the selected window, audio/camera settings, and exact action plan for explicit confirmation.
7. Start a detached Cap recording and retain its recording ID and project path.
8. Execute the steps with Computer Use.
9. Stop the exact Cap session, require recording metadata, validate the `.cap` project, and export MP4 locally.
10. Attach the MP4 to VPA and verify the returned scene ID and recording metadata.

If rehearsal or recording deviates from a required checkpoint, the skill stops capture and does not attach the take. Uploading to Cap Cloud is outside the VPA workflow and requires a separate user request and confirmation.

The skill does not install Cap automatically unless the user explicitly uses Cap's official setup authorization. When Cap is unavailable it reports the setup requirement and leaves manual upload available.

### 4. Session and ingestion bridge

Add a lightweight session resource so VPA can display the handoff state without controlling Codex:

- `POST /api/projects/:id/scenes/:sceneId/agent-recording/sessions` registers `rehearsing` or `recording` with a generated session ID.
- `PATCH .../sessions/:sessionId` updates state to `recording`, `exporting`, `attaching`, `failed`, or `completed`.
- Sessions are stored under `recording-plans/sessions/` and never treated as active merely because the preparation dialog was opened.
- Nonterminal sessions with no update for 30 minutes expire and display as interrupted.

Extend the existing per-scene upload route with optional, validated provenance fields:

- `source_kind: manual | cap-agent | bulk | split`;
- `capture_session_id`;
- `captured_at`;
- no Cap project path is persisted in the storyboard; a session may retain it temporarily for export retry and removes it from the session record after successful attachment.

`ingestRecording` remains the only code path that copies the MP4 into `recordings/<sceneId>.mp4`, probes metadata, updates the storyboard, and invalidates derived caches.

## Recording sequence

1. User opens a scene and selects “Record with Codex.”
2. VPA derives the plan and the user reviews target, steps, checkpoints, and capture settings.
3. User copies the Codex handoff into a Codex task in this repository.
4. The VPA skill fetches the reviewed plan and registers a rehearsal session.
5. Codex rehearses the target UI with Computer Use.
6. After a successful rehearsal, Codex resets the target and shows the exact capture proposal.
7. User explicitly approves capture.
8. Cap starts a detached local recording.
9. Codex executes the plan and verifies checkpoints.
10. Cap stops, validates, and exports MP4.
11. Codex uploads the MP4 to the existing VPA scene endpoint with Cap provenance.
12. VPA probes and ingests the recording, marks the session complete, invalidates workflow status, and shows the new recording in the scene.

## Capture defaults

- One application window rather than an entire display.
- Microphone and camera off.
- System audio off unless the plan explicitly requires it.
- Cursor visible.
- 1920×1080 at 30 fps unless the selected target requires a different supported mode.
- Two-second lead-in and tail.
- Notifications and unrelated sensitive applications closed before rehearsal.
- Dedicated demo accounts or fixtures for workflows that would otherwise expose private data.

VPA narration remains the preferred voice track. Capturing live narration would make automated retakes and script fitting less reliable.

## Safety and permissions

- Recording never begins solely because the plan was generated or copied.
- Before capture, Codex must show the exact target, audio/camera settings, and steps and receive explicit confirmation.
- The plan must not contain passwords, API keys, tokens, payment data, or private files.
- Destructive, account, credential, payment, publishing, and external communication actions are excluded by default. If a scene requires one, rehearsal stops and asks for a safer fixture or explicit user takeover.
- Cap Cloud upload and sharing are separate from local export and are not performed by this workflow.
- App permission prompts remain user-controlled.

## Error handling

- Cap unavailable or not capture-ready: show setup diagnostics and preserve manual upload.
- Computer Use cannot access the target: fail before recording.
- Rehearsal checkpoint failure: session becomes `failed`; no recording starts.
- Capture checkpoint failure: stop the exact session, retain diagnostic paths, do not attach.
- Missing Cap stop metadata or invalid `.cap` project: fail before export.
- Export failure: retain the validated Cap project for retry.
- VPA attachment failure: retain the MP4 path and offer retry; never report the scene as recorded.
- Interrupted sessions expire to `interrupted` and can be dismissed or restarted.

## Testing

### Unit tests

- Plan derivation from scene intent and shot plan.
- Plan validation and user-editable field restrictions.
- Session-state transition rules and expiry.
- Provenance schema compatibility with existing recordings.

### Route tests

- Plan GET/PUT and scene/project ownership checks.
- Session registration and legal/illegal transitions.
- Cap-provenance upload uses normal ingestion and cache invalidation.
- Failed attachments do not mutate the scene.

### Skill contract tests

- The skill requires rehearsal and confirmation before recording.
- The skill uses Cap CLI discovery and does not drive Cap's UI.
- The skill stops on unsupported terminal/ChatGPT targets.
- The skill never uploads to Cap Cloud as part of local scene capture.

### E2E tests

- Preparation dialog derives and displays a scene plan.
- Handoff text references the exact project and scene endpoint.
- Session state appears without covering the editor.
- Completed attachment refreshes scene recording metadata and workflow status.
- Manual upload remains usable when Cap is unavailable.

Cap itself and Computer Use are represented by fakes in automated tests. A documented manual acceptance test covers one real macOS browser scene from rehearsal through MP4 attachment.

## Rollout order

1. Shared plan, session, and provenance schemas.
2. Plan and session server services/routes.
3. Provenance-aware ingestion using the existing authoritative path.
4. Repository VPA recording skill.
5. Scene preparation dialog and Codex handoff.
6. Fake-backed E2E coverage.
7. One real macOS Cap acceptance recording.
8. Evaluate OBS support only after the Cap workflow proves reliable.
