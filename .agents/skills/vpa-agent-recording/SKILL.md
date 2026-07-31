---
name: vpa-agent-recording
description: Use when a VPA scene should be rehearsed and captured from a supported macOS browser or desktop application with Cap and Computer Use.
---

# Record a VPA Scene

## Core contract

Treat VPA's reviewed plan as the authority. Rehearse without recording, reset the target, obtain explicit confirmation, record one scene locally, then attach only a validated export.

## Workflow

1. Fetch the exact plan URL from the handoff. Validate project ID, scene ID, plan version, steps, checkpoints, and attachment endpoint. Register a `rehearsing` session.
2. Reject terminal and ChatGPT targets because Computer Use cannot operate them. Reject plans containing credentials, payments, publishing, external messages, destructive actions, or private data. Ask for a safe fixture instead.
3. Discover Cap's current interface; do not guess flags:
   - `cap guide --json`
   - `cap doctor --json`
   - `cap targets --json`
4. If Cap is missing or not capture-ready, report its diagnostics and stop. Do not install Cap automatically.
5. Rehearse every action with Computer Use while not recording. Verify every checkpoint. On any deviation, PATCH the session to `failed` and stop.
6. Reset the target to the plan's starting state. Show the user the exact window, dimensions, cursor, microphone, camera, system-audio settings, and ordered actions. Wait for explicit confirmation.
7. Start Cap in detached mode. Store the exact recording ID and temporary Cap project path in the session only. PATCH the session to `recording`.
8. Execute the plan with Computer Use, including the lead-in and tail. If a checkpoint fails, stop the exact recording ID, preserve diagnostics, PATCH `failed`, and do not attach.
9. Stop the exact recording ID. Require stop metadata, validate the `.cap` project, PATCH `exporting`, and export an MP4 locally. Never drive Cap's UI.
10. PATCH `attaching`. Upload the MP4 to the plan's attachment endpoint with `source_kind=cap-agent`, `capture_session_id`, and `captured_at`. Verify the response names the expected scene and includes recording metadata before PATCHing `completed`.

Cap Cloud upload or sharing is never part of this workflow. It requires a separate user request and confirmation.

## Quick reference

| State | Required evidence |
|---|---|
| `rehearsing` | Plan fetched; target supported |
| `recording` | Rehearsal passed; user confirmed; exact ID retained |
| `exporting` | Exact session stopped; metadata present; project valid |
| `attaching` | Local MP4 exists |
| `completed` | VPA verified the expected scene metadata |
| `failed` | Reason and safe retry point recorded |

## Common mistakes

- Opening the preparation dialog is not a session.
- Starting capture before rehearsal or explicit confirmation is a hard stop.
- A successful Cap export is not a successful VPA attachment.
- Never persist a local Cap project path in storyboard data.
- Never claim completion from a command exit code alone; verify the returned IDs and metadata.

Use [references/handoff-template.md](references/handoff-template.md) when reconstructing a handoff prompt.
