# Browser capture pilot

This checklist defines the supported pilot boundary for browser recording in VPA. The capture UI itself advertises the same boundary: desktop Chrome or Edge on macOS or Windows, up to 1920×1080 at 30 fps, with a 20-minute maximum take.

## Automated contract coverage

- Capture cannot begin before the user selects **Prepare capture**, reviews the preflight, and selects **Start recording**.
- Actual shared-audio availability is detected from the display stream; the UI never promises system audio that the browser did not supply.
- Permission denial, source/device end, recorder failure, upload interruption, missing chunks, conflicting retries, stale sessions, malformed media, and track-alignment failures preserve a recoverable incomplete session.
- Acknowledged chunks are ordered, checksummed, idempotent, and validated before assembled tracks enter the immutable source library.
- Screen, microphone, camera, and shared-audio tracks use one persisted clock and must remain within 100 ms at the start, midpoint, and end.
- Stop, cancel, failure, and component teardown release browser media streams.

## Manual release matrix

For each row, record a 30-second take and a 20-minute ceiling take. Include microphone and camera once, then repeat without shared audio. Confirm preflight preview/levels, countdown, elapsed timer, stop/save, playback, source-tray entries, and composition alignment at the start, midpoint, and end.

| OS | Chrome | Edge |
| --- | --- | --- |
| macOS | Pending release pilot | Pending release pilot |
| Windows | Pending release pilot | Pending release pilot |

Also interrupt one take in each browser by ending the shared source and one by temporarily stopping the VPA server. After restart, confirm the take appears under **Recoverable takes** and can either assemble successfully or fail with a specific retained diagnostic.

Native uploads and agent/Cap captures remain in the same source library. Assign one of those sources to a scene and select **Create editable composition** to verify it enters the same non-destructive clip workflow as browser capture.
