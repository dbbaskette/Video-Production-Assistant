# VPA-Managed Cap and Codex CLI Integration Design

## Summary

Replace the clipboard-based scene-recording handoff with a VPA-owned workflow. VPA installs and invokes Cap Desktop's released CLI, launches Codex CLI directly for rehearsal and scene execution, provides Codex with a constrained macOS desktop-control helper, and keeps the user-facing recording confirmation inside VPA.

Cap remains a separate runtime dependency. VPA does not clone, vendor, fork, or link against the Cap repository. Local scene recording and export do not require Cap Cloud upload, Cap account authentication, Cap's agent skill, or Cap's MCP server.

This design supersedes the clipboard handoff and Codex Computer Use assumptions in `2026-07-31-cap-agent-recording-design.md`. The existing reviewed plan, session, provenance, ingestion, and manual-upload work remains the foundation.

## Problem

The first recording attempt exposed two independent failures:

1. VPA generated commands for a `cap` executable without detecting or installing Cap Desktop and its CLI. The current Mac has neither installed.
2. VPA copied a prompt for the user to paste into Codex instead of dispatching it. A spawned `codex exec` process can receive the task directly, but it does not have the ChatGPT desktop app's Computer Use runtime. It does have shell execution and image inspection, so it needs a VPA-provided desktop-control surface for macOS applications.

Merely adding `codex exec` would automate delivery of a workflow that still cannot record or operate the target. The replacement must own setup, capture, agent dispatch, desktop control, confirmation, validation, and attachment as one coordinated flow.

## Goals

- Make Cap setup discoverable and executable inside VPA after one explicit install confirmation.
- Use the official Cap Desktop release and its version-matched CLI without modifying the user's shell profile.
- Invoke Cap by an absolute, verified path and re-discover its installed command contract before recording.
- Add Codex CLI as a first-class VPA model provider alongside Claude Code CLI.
- Dispatch scene rehearsal directly with `codex exec`; remove clipboard handoff as the primary action.
- Drive one approved macOS target application through a constrained VPA helper available to Codex CLI.
- Keep rehearsal and exact target/settings review before the recording confirmation.
- Let VPA, not the agent, own Cap start, stop, validation, export, and attachment.
- Preserve exact Cap recording IDs, Codex thread IDs, diagnostics, and retry-safe session state.
- Keep local capture local. Do not authenticate to Cap Cloud or upload/share unless a separate future workflow is explicitly requested.
- Preserve manual upload and copy-instructions as fallbacks.

## Non-goals

- Embedding or rebuilding Cap's Rust/Tauri recording stack inside VPA.
- Installing Cap's global Codex skill or MCP configuration as a prerequisite.
- Supporting Windows or Linux desktop automation in this iteration.
- Recording a whole storyboard unattended.
- Driving Terminal, ChatGPT, credential, payment, publishing, destructive, or external-communication flows.
- Automating macOS Screen Recording, Accessibility, or other privacy permission prompts.
- Uploading a recording to Cap Cloud.
- Replacing existing Gemini, Anthropic, Claude CLI, or OpenAI-compatible providers.

## Product Decisions

### Cap is an external managed runtime

VPA uses Cap Desktop and the CLI shipped in its application bundle. It does not consume Cap source code as a library. This keeps Cap's application lifecycle, capture engine, macOS entitlements, updater, and release compatibility within Cap's supported distribution boundary.

VPA recognizes these CLI locations in order:

1. the last verified absolute path stored in VPA setup state;
2. `<VPA_HOME>/bin/cap`, the VPA-managed shim;
3. `cap` resolved from the server process environment;
4. `/Applications/Cap.app/Contents/MacOS/cap-cli`;
5. `~/Applications/Cap.app/Contents/MacOS/cap-cli`.

Every candidate must be an executable regular file or symlink whose target exists. VPA runs `version --json` before marking it usable.

### VPA owns Cap; Codex owns scene actions

Codex never starts, stops, validates, exports, uploads, or attaches a recording. Those actions are deterministic and belong in the server-side coordinator. Codex receives only the reviewed scene plan and access to the target-scoped desktop helper.

The split prevents an agent response, timeout, or hallucinated command from losing the exact Cap recording ID or attaching an unvalidated file.

### Confirmation lives in VPA

The rehearsal Codex turn ends after returning structured evidence. VPA presents the exact selected window, dimensions, cursor, microphone, camera, system-audio choices, and ordered actions. Only the scene dialog's **Confirm & record** action authorizes capture.

The confirmation applies to one session and one reviewed plan fingerprint. Changing the plan, target, or capture settings invalidates the rehearsal and requires another rehearsal.

### Cap integration does not require Cap's agent integration

Cap's agent skill and local MCP are useful when an agent manages a Cap library. VPA needs only the local CLI recording surface, so it does not modify global Codex configuration or require a Codex restart. VPA still runs `cap guide --json` and command help from the installed binary rather than assuming flags.

## Architecture

The implementation adds five bounded components.

### 1. Cap runtime service

`CapRuntime` owns discovery, install, diagnostics, targets, recording, validation, and export. Callers receive typed results and never assemble Cap arguments themselves.

The service exposes these operations:

- `getStatus()` returns installation, version, CLI path, capture readiness, permissions, and the last setup error.
- `installOfficial()` runs the official installer only after the API has received `{ confirmed: true }`.
- `refreshGuide()` runs `guide --json` and caches it only for the installed Cap version.
- `doctor()` and `targets()` return parsed JSON without converting a successful diagnostic exit into capture readiness.
- `startRecording()` launches detached capture and requires a returned recording ID and project path.
- `stopRecording()` stops the exact ID and requires `recordingMetaExists: true`.
- `validateProject()` requires `valid: true`.
- `exportProject()` consumes Cap's JSONL stream and resolves only on a terminal success event whose output file exists.

The installer is downloaded from the fixed official HTTPS installer URL to a temporary file, then executed after confirmation. VPA sets:

- `CAP_CLI_INSTALL_DIR=<VPA_HOME>/bin`;
- `CAP_NO_MODIFY_PATH=1`;
- no authentication or account token environment variables.

Installer stdout/stderr is captured as bounded diagnostics. VPA verifies the resulting binary independently and does not trust the installer exit code alone. Installation may place Cap Desktop in `/Applications` or `~/Applications` according to the official installer behavior. macOS Gatekeeper and privacy prompts remain user-controlled.

Setup state is persisted under `<VPA_HOME>/setup/cap.json`. It contains only the verified CLI path, version, timestamps, and non-secret diagnostics.

### 2. Codex CLI process adapter

A reusable `CodexCliProcess` utility spawns `codex exec`, sends prompts through stdin, parses JSONL events, captures bounded stderr, applies timeouts and abort signals, and returns:

- Codex thread ID from `thread.started`;
- final agent message;
- structured terminal state;
- usage when present;
- normalized failure diagnostics.

The adapter never uses shell interpolation. Executable and arguments are passed separately.

Two callers use the adapter:

1. `createCodexCliLlm()` implements the existing `LlmClient` interface for ordinary VPA generation. It uses `codex exec --ephemeral --json --sandbox read-only`, omits `--model` when the configured value is `default`, and parses the final agent message.
2. `AgentRecordingCoordinator` starts a persistent recording thread for rehearsal and resumes that exact thread after confirmation. It uses the repository as the working directory and a workspace-write sandbox so Codex can create only session-scoped screenshots and invoke the approved helper. Its prompt forbids source edits and Cap commands.

Add provider ID `codex-cli` to server config, model registry, factory routing, Settings, and provider tests. The seeded model entry is **Codex CLI** with model `CODEX_MODEL` or `default`. It reuses the user's existing Codex CLI authentication and does not accept an API key in VPA.

### 3. Target-scoped macOS desktop helper

Codex CLI has shell execution and image inspection but not the desktop app's Computer Use runtime. VPA supplies a local helper with these commands:

- `inspect`: return a bounded JSON accessibility tree for the approved application;
- `screenshot`: capture only the approved window and return a session-scoped PNG path;
- `click`: click a fresh accessibility element index returned by `inspect`;
- `set-value`: set a non-sensitive value on an editable accessibility element;
- `type-text`: type non-sensitive fixture text into the approved application;
- `press-key`: send an allow-listed navigation or shortcut key to the approved application.

The helper is macOS-only and implemented with system Accessibility APIs plus the system screenshot facility. It is not a general AppleScript executor and does not accept arbitrary scripts, processes, bundle IDs, file paths, coordinates, or shell commands from Codex.

Each helper invocation carries an opaque session capability generated by VPA. The server-side capability binds:

- project and scene;
- reviewed plan fingerprint;
- target application identity;
- allowed operation set;
- expiration time;
- whether the phase is rehearsal or recording.

The target application is resolved during rehearsal and cannot be replaced by a CLI argument. The helper refuses Terminal, ChatGPT, Cap, VPA, system settings, password managers, and any application other than the resolved target. Element indexes expire after the next `inspect` or visible state change, forcing Codex to re-read the interface.

Screenshots are written under a session-specific temporary directory, are readable by Codex `view_image`, and are removed after the session reaches a terminal state. No screenshot is attached to the VPA project.

Accessibility and Screen Recording permissions are checked before rehearsal. If unavailable, VPA shows the exact permission category and stops. VPA never clicks a system privacy prompt on the user's behalf.

### 4. Agent recording coordinator

The coordinator is the only component allowed to advance an agent recording session. It serializes work per scene and owns all child processes.

Extend the session state enum to:

- `rehearsing`;
- `awaiting_confirmation`;
- `recording`;
- `exporting`;
- `attaching`;
- `completed`;
- `failed`;
- `interrupted`.

Allowed transitions are:

- `rehearsing -> awaiting_confirmation | failed | interrupted`;
- `awaiting_confirmation -> recording | failed | interrupted`;
- `recording -> exporting | failed | interrupted`;
- `exporting -> attaching | failed | interrupted`;
- `attaching -> completed | failed | interrupted`.

The public session adds phase copy, rehearsal evidence, confirmed settings, and progress timestamps. Internal storage may additionally hold the Codex thread ID, capability token hash, exact Cap recording ID, Cap project path, export path, and bounded event log. Internal paths and capability material are never returned to the browser.

#### Rehearsal

1. Save and fingerprint the reviewed plan.
2. Require usable Cap status, `captureReady: true`, at least one matching target, and required macOS permissions.
3. Create a `rehearsing` session and target-scoped helper capability.
4. Launch Codex CLI directly with the plan embedded as structured context; do not make Codex fetch VPA over HTTP.
5. Require Codex to inspect the target, rehearse all actions without Cap running, reset the target, and return a response conforming to a VPA-owned JSON Schema.
6. Independently inspect the target once more and compare the resolved application/window evidence with the plan.
7. Store the Codex thread ID and rehearsal evidence, then transition to `awaiting_confirmation`.

The rehearsal schema includes success, resolved application, window title and bounds, completed step indexes, checkpoint results, reset confirmation, and a user-facing diagnostic. Missing or malformed evidence fails the session.

#### Confirmed recording

1. Accept confirmation only for an `awaiting_confirmation` session whose plan fingerprint still matches.
2. Re-run Cap doctor and target discovery.
3. Start detached Cap capture and persist the exact recording ID before changing session state.
4. Wait the configured lead-in.
5. Resume the exact Codex thread with a server-authored message that recording is active and asks it to execute the already rehearsed plan through the helper.
6. Require structured execution evidence; do not rely on a successful process exit alone.
7. Wait the configured tail, stop the exact Cap recording, and require recording metadata.
8. Validate the `.cap` project, export MP4 locally, and verify that the file is readable and non-empty.
9. Move to `attaching` and call the existing authoritative scene-ingestion path with `source_kind=cap-agent`, session ID, and capture time.
10. Verify the returned project and scene recording metadata before marking `completed`.

If Codex fails or times out after capture starts, the coordinator stops the exact Cap recording, preserves local diagnostics, marks the session failed, and does not attach the take.

#### Cancellation and recovery

The user may cancel any nonterminal session. If Cap is active, cancellation first attempts to stop the exact ID. A successful stop may preserve a local `.cap` project, but cancellation never exports or attaches it automatically.

On server restart, any nonterminal session is reconciled from persisted IDs and files. VPA may offer **Retry export** or **Retry attachment** only when the previous verified artifact supports that exact retry. Rehearsal and recording are never silently resumed after a restart.

### 5. VPA setup and scene UX

#### Cap setup

The recording dialog begins with a Cap status panel:

- **Not installed**: show what will be downloaded and where, plus **Install Cap**.
- **Installing**: show bounded progress and disable duplicate installation.
- **Needs permission**: show the missing macOS permission and **Open System Settings** as a user-invoked handoff.
- **Ready**: show Cap version, selected target, and capture readiness.
- **Problem detected**: show the actionable diagnostic, **Retry check**, and manual upload.

Selecting **Install Cap** first shows a confirmation naming Cap Desktop, the official download source, the application destination behavior, and the VPA CLI shim location. Confirming that sheet is the authorization for the one installation attempt.

#### Recording preparation

Replace **Save & copy Codex handoff** with **Save & rehearse with Codex**. The dialog shows live phases for saving, checking Cap, checking permissions, launching Codex, operating the target, verifying reset, and awaiting confirmation.

At `awaiting_confirmation`, the dialog shows:

- resolved application and window title;
- actual target dimensions and requested output dimensions/fps;
- cursor, microphone, camera, and system-audio state;
- ordered actions and rehearsal result for each;
- checkpoints and reset result;
- explicit statement that capture remains off;
- **Confirm & record**, **Rehearse again**, **Cancel**, and **Upload manually**.

During recording, the dialog shows the active phase and a persistent **Stop** action. It does not expose internal Cap paths. On completion it closes only after the scene query, workflow status, and recording metadata have refreshed.

**Copy instructions** remains under troubleshooting. It includes the plan and diagnostics but is not presented as the normal route.

## API Surface

Add setup routes:

- `GET /api/setup/cap` returns `CapSetupStatus`.
- `POST /api/setup/cap/install` accepts `{ confirmed: true }`, starts one installation job, and returns its job/status identity.
- `POST /api/setup/cap/check` refreshes read-only discovery and diagnostics.

Extend scene recording routes:

- `POST /api/projects/:id/scenes/:sceneId/agent-recording/rehearse` saves the reviewed update and starts the coordinator.
- `POST /api/projects/:id/scenes/:sceneId/agent-recording/sessions/:sessionId/confirm` accepts `{ confirmed: true, planFingerprint }`.
- `POST /api/projects/:id/scenes/:sceneId/agent-recording/sessions/:sessionId/cancel` requests safe cancellation.
- Existing plan and current-session GET routes remain.
- Direct browser-authored arbitrary session transitions are removed; only the coordinator may transition internal state.

Long-running route handlers return promptly. The web app polls the existing current-session query with a short interval while a session or install is active. Server logs and persisted event arrays are bounded to prevent unlimited growth.

## Safety and Privacy

- Installation, recording, and any future upload are separate confirmation boundaries.
- The install endpoint accepts only a boolean confirmation; it does not accept a URL, script, destination, or executable from the browser.
- The official installer URL is a server constant.
- Cap account credentials and environment tokens are not read or stored for local recording.
- Codex prompts contain no local secrets, Cap tokens, or arbitrary filesystem paths.
- The helper operates only the approved target application and rejects excluded applications.
- The coordinator starts Cap only after VPA receives the explicit, session-bound recording confirmation.
- Microphone, camera, and system audio default off.
- Cap Cloud upload and sharing do not occur.
- A failed validation, malformed JSON event, mismatched identifier, missing file, stale plan, or uncertain target is a hard stop.

## Error Handling

- **Cap absent:** offer confirmed installation and manual upload.
- **Installer fails:** preserve bounded installer diagnostics, re-run discovery, and do not claim partial success.
- **Cap CLI version/guide invalid:** mark setup unusable and offer reinstall/check.
- **Capture permission unavailable:** stop before rehearsal and hand off to System Settings.
- **Codex CLI absent or unauthenticated:** show the exact local CLI diagnostic and preserve copy/manual fallbacks.
- **Target cannot be uniquely resolved:** ask the user to choose among Cap target results; do not guess.
- **Accessibility helper cannot inspect the app:** fail rehearsal before capture.
- **Rehearsal or reset fails:** mark failed and require a new rehearsal.
- **Plan changes after rehearsal:** invalidate confirmation and rehearse again.
- **Cap start response lacks ID/path:** stop and fail without entering `recording`.
- **Agent execution fails while recording:** stop the exact Cap ID, retain diagnostics, do not attach.
- **Cap stop metadata missing:** do not validate or export.
- **Project validation fails:** preserve local project path internally for diagnosis; do not export.
- **Export fails:** preserve verified project and allow exact export retry.
- **Attachment fails:** preserve verified MP4 and allow exact attachment retry.
- **Cancellation/interrupt:** stop active capture when possible and never attach automatically.

## Testing

### Unit tests

- CLI discovery precedence, stale path recovery, executable validation, and version parsing.
- Official installer environment and argument construction without executing a network installer.
- Cap JSON and JSONL parsing, diagnostic readiness fields, exact recording ID handling, and terminal export events.
- Codex JSONL parsing, final-message selection, thread ID extraction, errors, timeouts, and aborts.
- `codex-cli` provider routing and omission of `--model` for `default`.
- Session transitions, plan-fingerprint invalidation, cancellation, and restart reconciliation.
- Desktop-helper target binding, operation allow-list, stale element indexes, excluded apps, and screenshot cleanup.

### Route tests

- Cap setup status, confirmed install requirement, concurrent-install rejection, and re-check.
- Rehearsal starts asynchronously and rejects stale/unsupported plans.
- Confirmation requires the exact awaiting session and fingerprint.
- Browser clients cannot patch arbitrary session states.
- Cancellation stops the exact fake recording.
- Completed coordination uses existing ingestion with correct provenance.

### Component and E2E tests

- Missing Cap shows setup rather than a command-not-found failure.
- Install confirmation copy and progress are visible.
- Save-and-rehearse dispatches directly without touching the clipboard.
- Awaiting-confirmation view shows verified target and capture settings.
- Recording cannot begin without the confirmation request.
- Failure and cancellation preserve manual upload.
- Completion refreshes scene recording metadata and workflow status.

Automated tests use fake Cap, Codex, and desktop-driver adapters. They never download Cap, operate a real application, or record the screen.

### Manual macOS acceptance

After automated verification, perform one explicit acceptance run:

1. Use **Install Cap** and verify Cap Desktop plus `<VPA_HOME>/bin/cap`.
2. Grant macOS permissions manually when prompted.
3. Rehearse the MeetingNotes Settings scene through General, Model, and Integration.
4. Verify VPA shows the correct window and capture settings before recording.
5. Confirm recording in VPA.
6. Verify the exact Cap session stops, validates, and exports.
7. Verify VPA attaches the MP4 to `scene-01` with `source_kind: cap-agent`.
8. Confirm no Cap Cloud item or share link was created.

The acceptance run is reported separately and is not considered passed unless the real application, Cap binary, exported MP4, and VPA scene metadata are all verified.

## Rollout

1. Cap runtime discovery, typed status, and fake-backed setup routes.
2. Confirmed official installer flow.
3. Codex CLI provider and shared JSONL subprocess adapter.
4. Target-scoped macOS desktop helper and permission checks.
5. Coordinator-owned rehearsal, confirmation, capture, export, and attachment.
6. Revised scene dialog and fallback actions.
7. Automated regression suite.
8. Real MeetingNotes macOS acceptance run.

ShareX and OBS remain future recorder adapters behind the same coordinator boundary. They are not added until the Cap path completes the real acceptance run.
