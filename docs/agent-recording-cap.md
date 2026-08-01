# Cap + Codex scene recording

VPA can rehearse and capture one supported macOS application-window scene with Cap and Codex CLI. VPA coordinates the take from setup through attachment; Codex performs only the reviewed target-application actions.

## Runtime boundary

Cap Desktop is an external runtime, not a vendored VPA library. VPA installs the official released application and uses the version-matched CLI shipped with it. VPA verifies that CLI and creates a shim under its own local data directory; it does not modify the user's shell profile, clone Cap's source, install Cap's global agent skill, or require Cap's MCP server.

Codex CLI is launched directly with `codex exec` and reuses the user's existing local Codex authentication. VPA embeds the reviewed plan in the Codex request and supplies a short-lived, scene-bound desktop-driver capability. There is no normal copy-and-paste handoff.

## Set up Cap

1. Open a scene's **Recording** tab and choose **Set up recording**.
2. If Cap is absent, choose **Install Cap** and review the confirmation sheet. **Download and install Cap** authorizes one official installer attempt.
3. VPA downloads and verifies Cap, reports installation progress, and then checks capture readiness and available windows.
4. If macOS Screen Recording or Accessibility permission is missing, choose **Open System Settings**, grant it manually, return to VPA, and choose **Retry check**. VPA never approves a macOS privacy prompt for the user.

The status panel reports **Not installed**, **Installing**, **Needs permission**, **Ready**, or an actionable problem. Installation and recording are separate confirmation boundaries.

## Record a scene

1. Review the target application, ordered actions, checkpoints, dimensions, frame rate, cursor, microphone, camera, and system-audio settings.
2. Choose **Save & rehearse with Codex**. VPA saves and fingerprints the plan, verifies Cap and permissions, and dispatches Codex CLI directly.
3. Codex uses only `scripts/vpa-desktop-driver.mjs` to inspect the approved application, rehearse the actions without capture, verify checkpoints, and restore the starting state.
4. VPA independently verifies the target and displays the resolved application/window, actual bounds, reviewed output settings, actions, checkpoints, and reset result. Capture remains off.
5. Choose **Confirm & record** only after reviewing that exact evidence. Confirmation applies to one session and one plan fingerprint; changing the plan or target requires another rehearsal.
6. VPA starts the exact local Cap take, resumes the same Codex thread to execute only the rehearsed actions, stops and validates the take, exports an MP4 locally, and attaches it through the normal scene-ingestion path.

During the take, VPA shows the active recording, export, and attachment phases. **Stop** safely cancels a nonterminal take. VPA reports completion only after the expected scene metadata is refreshed.

## Privacy and safety

- Capture defaults to one application window with the cursor on and microphone, camera, and system audio off.
- Use dedicated demo accounts and non-sensitive fixtures. Plans must not include secrets, payments, publishing, destructive actions, private data, or external communication.
- The desktop driver is capability-bound to the reviewed target and refuses Cap, VPA, Terminal, ChatGPT, System Settings, password managers, and other applications.
- Cap recording, validation, and export remain local. VPA does not authenticate to Cap Cloud and never uploads or shares a Cap item.
- Session capability tokens, internal paths, screenshots, and Cap project paths are not stored in the storyboard or returned to the browser.

## Failure and fallback actions

- **Retry check** repeats Cap discovery and permission diagnostics.
- **Rehearse again** is required after stale-plan, target, action, checkpoint, or reset failures.
- **Cancel** or **Stop** ends the active workflow without automatically exporting or attaching a take.
- **Upload manually** remains the supported fallback when no agent take is active.
- **Copy instructions** under Troubleshooting is a non-primary diagnostic handoff for a failed direct Codex launch. It does not authorize rehearsal or recording.

VPA does not attach a take after malformed evidence, a stale fingerprint, a target mismatch, failed validation, missing recording metadata, or uncertain export/attachment state.

## Verification status

Automated tests use fake Cap status, fake asynchronous sessions, and intercepted local APIs. They do not download Cap, operate MeetingNotes, request macOS permissions, record the screen, or contact Cap or Codex.

The real macOS acceptance run is still unverified. Do not report this workflow as accepted until a user explicitly installs/verifies the real Cap runtime, grants permissions, rehearses the MeetingNotes Settings scene, confirms the reviewed target and settings, produces a local MP4, verifies `source_kind: cap-agent` on `scene-01`, and confirms that no Cap Cloud item or share link was created.
