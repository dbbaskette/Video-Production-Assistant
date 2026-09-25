# Foundation: Immutable Assets, Revisions, and Durable Jobs

## Status and issue grouping

This specification implements the first P1 delivery group under roadmap issue #88:

- #90 — immutable source media and source-tray assignment
- #91 — authoritative revisions, atomic command batches, and restore
- #99 — durable bounded jobs and local-server trust boundaries

These issues ship together because later capture, editing, evidence, feedback, and render work must refer to stable asset IDs and revisions and must survive process restarts.

## Outcomes

1. Imported media is immutable and content-addressed. Replacing a scene recording changes a reference; it never overwrites prior source bytes.
2. Every accepted project mutation has one monotonically increasing authoritative revision. Multi-command requests are validated against one starting state and commit fully or not at all.
3. Background job identity, frozen inputs, progress, terminal artifacts, and bounded public failures survive server restarts.
4. The local API rejects untrusted Host/Origin values and project-owned paths cannot escape through traversal or symlinks.

## Asset library

Each project owns `.vpa/assets/manifest.json` and immutable originals under `.vpa/assets/originals/`. An asset record contains a stable ID derived from its SHA-256 checksum, original filename, safe project-relative source path, media kind, MIME type, byte size, import timestamp, preparation status, optional duration/dimensions, and a timing origin. Reimporting identical bytes returns the existing asset record.

Supported source types are MP4/WebM, PNG/JPEG, and MP3/WAV. Files are staged and size-checked before commit. Video duration is limited to 20 minutes and every file is limited to 2 GiB. Unsupported, malformed, over-limit, interrupted, and disk-write failures leave no manifest entry and do not alter scene references.

Existing `recordings/...` sources are migrated lazily: VPA copies them into the library, preserves the old file, records a legacy origin, and updates the scene on the next explicit assignment/mutation. Existing projects remain readable before migration.

The source tray lists persisted assets with preparation/error state. Bulk import first produces an editable file-to-scene mapping. Commit validates every target and asset before changing any scene. Screen, microphone, camera, and other linked recordings may share `capture_session_id` and `timing_origin_ms` without being flattened into one file.

## Authoritative revisions and commands

Project revision state lives under `.vpa/revisions/`. Revision 0 is bootstrapped from the current `project.yaml` and `storyboard.yaml`; each later revision stores a validated full snapshot plus command metadata. Source bytes are references and are never copied into revision snapshots.

`POST /api/projects/:id/commands` accepts:

```ts
{
  expectedRevision: number;
  idempotencyKey: string;
  commands: ProjectCommand[];
}
```

Initial commands cover assigning an asset, patching/adding/deleting/reordering scenes, patching project metadata, and restoring a prior revision. The service:

1. serializes mutations per project;
2. checks an existing idempotency key before work;
3. rejects a changed payload for a reused key;
4. rejects a stale expected revision with the current revision;
5. applies all commands to cloned in-memory documents;
6. validates the final project, storyboard, asset references, and time ranges;
7. commits both documents through a recoverable transaction journal;
8. writes a revision snapshot and durable idempotency result.

A matching retry returns the original result without adding a revision. Restore creates a new revision whose mutable state equals the chosen historical snapshot; it does not move the revision counter backward or alter immutable sources.

Existing specialized endpoints remain compatible in this group. New source-tray assignment uses the command service, and later issue groups migrate additional mutations onto it.

## Durable jobs

The global job ledger is stored at `$VPA_HOME/jobs.json` using atomic writes. The job schema adds:

- `interrupted` as a recoverable status;
- optional idempotency key and input fingerprint;
- frozen `inputRevision` and bounded metadata;
- structured public failure `{ code, message, retryable }`;
- artifact descriptors that identify the producing revision/fingerprint.

Creation is durably recorded before work starts. A matching idempotent retry returns the same job; a changed fingerprint conflicts. State/event changes are queued to the atomic writer. Event history, result, error, metadata, and artifact payloads are bounded before persistence. At startup, pending/running/cancelling work becomes `interrupted`, preserving identity and inputs for an explicit retry. Cancellation is idempotent and supports a registered abort callback for child processes.

The existing string `error` field remains for compatibility while new code uses `failure`.

## Local security boundaries

- The server must bind to a loopback host; non-loopback configuration fails startup.
- Requests must carry an allowed loopback Host. Mutating requests with Origin must match the configured web origin.
- Project IDs resolve only through the tracker.
- Every project-relative read/write path is normalized, containment-checked, and rejected if an existing path component is a symbolic link.
- Public errors are bounded and exclude absolute project paths, provider secrets, command lines, and raw stderr.

## Compatibility and exclusions

- Existing storyboard `recording.source` remains present so current preview/render code keeps working. `asset_id`, media role, and timing origin are additive.
- Existing recording upload endpoints use the new immutable library but keep their response shapes.
- Thumbnail/proxy preparation is modeled and persisted in this group; generation hooks are included, while richer waveform/contact-sheet generation belongs to #95.
- Browser capture (#92), composition edits/audio mixing (#93), overlay/redaction (#94), transcription/evidence (#95), feedback/compare (#97), revision-frozen render UX (#98), and orchestration (#100) remain later groups.

## Acceptance criteria

- Uploading replacements never changes the bytes of an earlier asset and duplicate bytes deduplicate.
- Users can import supported media, inspect the source tray, edit and commit file-to-scene mapping, and retry failed preparation.
- Legacy recordings remain intact and can be registered without destructive migration.
- Atomic command batches reject stale revisions and invalid references without partial state changes.
- Matching idempotent command retries return the original result; changed-payload reuse conflicts.
- Restore creates a new revision with the prior mutable state.
- Jobs survive restart, in-flight jobs become interrupted, retries/cancellation are idempotent, and persisted/public data is bounded.
- Traversal, symlink escape, untrusted Host/Origin, malformed media, oversize media, and simulated persistence failures are covered by tests.
- Shared, server, web, CLI, repository typecheck/build, and the full relevant test suite pass.
