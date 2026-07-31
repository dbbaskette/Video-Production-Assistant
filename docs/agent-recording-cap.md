# Cap agent recording

VPA can prepare one storyboard scene for Codex to rehearse and record with [Cap](https://cap.so/). VPA owns the reviewed scene plan and final attachment. Cap owns local capture and export. Codex Computer Use operates the supported browser or desktop application.

## Prerequisites

- macOS with Cap installed and granted Screen Recording permission.
- A Codex task opened in this repository with Computer Use available.
- VPA server and web app running locally.
- A browser or desktop target. Terminal applications and ChatGPT are not supported targets for this workflow.

Cap is not installed automatically. The repository skill begins with Cap's structured discovery commands and reports setup diagnostics when capture is unavailable.

## Record a scene

1. Open the scene's **Recording** tab and choose **Record with Codex**.
2. Select the target application, optional starting URL, capture target, frame rate, cursor, and audio/camera choices.
3. Review the ordered actions and readiness checklist. Rehearsal is always required.
4. Choose **Save & copy Codex handoff** and paste the prompt into a Codex task in this repository.
5. Codex loads `$vpa-agent-recording`, fetches the exact saved plan, checks Cap readiness and available targets, and registers a rehearsal session.
6. Codex rehearses every step without recording and verifies checkpoints.
7. After reset, Codex shows the exact target and capture settings. Recording starts only after explicit confirmation.
8. Cap records locally while Computer Use performs the plan. Codex stops the exact session, validates the Cap project, exports MP4, and attaches it to the intended scene.
9. VPA probes the MP4, saves it under `recordings/<sceneId>.mp4`, stores Cap provenance, invalidates derived media, and marks the session complete.

Copying the handoff does not launch Codex or start a recording. VPA displays progress only after Codex registers a real session.

## Privacy and safety defaults

- Capture one application window rather than an entire screen.
- Cursor on; microphone, camera, and system audio off.
- Use dedicated demo accounts or safe fixtures.
- Close notifications and unrelated applications before rehearsal.
- Do not include passwords, tokens, payment data, private files, destructive actions, publishing, or external communications in a plan.
- Cap Cloud upload and sharing are not part of the workflow.

## Failure and recovery

- Rehearsal mismatch: stop before recording and adjust the plan or fixture.
- Capture mismatch: stop the exact Cap recording, retain diagnostics, and do not attach the take.
- Invalid Cap project or missing stop metadata: do not export.
- Export failure: retain the local Cap project for retry.
- Attachment failure: retain the exported MP4 and retry only after the session is back in the correct attaching state.
- No session update for 30 minutes: VPA marks it interrupted.

Manual upload remains available in the preparation dialog and on the Recording tab at every stage.

## Acceptance check

Automated tests use fake media and validate plan persistence, session transitions, provenance, and the repository skill contract. A real acceptance run requires Cap and macOS permissions: rehearse one browser scene, approve capture, export locally, attach it, and confirm the scene shows `source_kind: cap-agent`. This external acceptance step must not be reported as passed unless it was actually performed.
