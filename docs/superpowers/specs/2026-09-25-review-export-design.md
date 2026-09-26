# Traceable feedback and revision-correct Review & Export

Feedback notes are durable storyboard records anchored to a revision, clip instance, immutable source interval, and optional normalized rectangle. Pending, claimed, resolved, and failed lifecycle transitions are revision commands; resolution names the produced revision. Missing clips become `reanchor-required` and are never silently reassigned.

Each render runs from a frozen project snapshot and produces an immutable artifact named by job/revision. Its manifest records artifact/job/revision IDs, input fingerprint, source checksums, full render settings, renderer version, fonts, output probe, and completion time. The current manifest is a pointer-like copy; historical artifacts remain playable through failure, cancellation, and retries. Staleness is revision/fingerprint based, never elapsed-time based.

Review & Export leads with the current artifact, playback/download, exact provenance, stale/changed-input explanation, and prior artifacts. Quality review persists with its input fingerprint/revision and reports stale only when current inputs differ. Feedback note entry/claim/resolve, revision compare, and restore are keyboard-operable and exposed through HTTP for the existing VPA CLI/skill surface.
