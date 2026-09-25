# Foundation: Immutable Assets, Revisions, and Durable Jobs Implementation Plan

## Contract

Implement `docs/superpowers/specs/2026-09-25-foundation-assets-revisions-jobs-design.md` and close #90, #91, and #99 as one independently shippable foundation group.

## Slice 1 — Shared contracts and safe paths

**Files:** `packages/shared/src/asset.ts`, `command.ts`, `job.ts`, `storyboard.ts`, exports; server project path helpers and tests.

- Define bounded schemas for assets, source roles, command batches/results/conflicts, revisions, durable job failures/artifacts, and interrupted status.
- Add optional asset/timing fields to recordings without breaking legacy files.
- Add project-relative containment and symlink checks used by all new storage.

**Verification:** schema tests reject unsafe paths, invalid time ranges, invalid IDs, oversized event metadata, and malformed command batches.

## Slice 2 — Immutable asset service and source-tray API

**Files:** new `services/assets/`, asset routes, recording ingestion integration, route/service tests, web API/page components.

- Stage, fingerprint, probe, and atomically persist supported sources.
- Deduplicate by checksum and preserve legacy files during registration.
- List/stream/retry assets and expose editable mapping preview/commit.
- Route existing recording ingestion through immutable originals.
- Add a source tray and editable mapping review to Recordings.

**Verification:** duplicate/replacement, malformed/unsupported/oversize/duration, interruption/persistence failure, legacy migration, mapping validation, and browser UI tests.

## Slice 3 — Revision and command service

**Files:** new `services/revisions/`, command routes, storyboard/project integration points, tests.

- Bootstrap revision 0 and serialize mutations per project.
- Implement expected-revision and idempotency conflict behavior.
- Validate/apply command batches in memory, then commit with a recoverable journal.
- Persist snapshots and restore as a new revision.
- Make source-tray assignments use this service.

**Verification:** full rollback, stale writers, duplicate retry, changed-payload key, missing asset, invalid ranges, interrupted transaction recovery, and restore.

## Slice 4 — Durable bounded job ledger

**Files:** shared job schema, `lib/job-queue.ts`, server bootstrap/routes, producers as needed, tests.

- Configure persistence before route registration and load jobs on startup.
- Persist create/status/events/result/failure/artifacts atomically.
- Bound histories and public fields; add idempotent create/retry and structured failures.
- Recover in-flight work as interrupted and support abort callbacks.

**Verification:** restart recovery, write failure, idempotent retry/conflict, event bounds, cancellation race, and compatibility with narration/render callers.

## Slice 5 — Local trust boundary and integration

**Files:** server startup/hooks/config, path helpers, API tests, docs.

- Enforce loopback bind/Host and exact configured Origin for mutations.
- Reject traversal and symlink escape in new project storage.
- Confirm errors do not disclose absolute paths or secrets.
- Run one immutable-import → mapping-command → revision-restore smoke test and one durable-job restart smoke test.

## Integrated verification owner

The primary implementation session owns targeted checks at slice boundaries and, once the group is integrated, the full workspace tests, typecheck, build, diff audit against #90/#91/#99, PR creation, CI inspection, merge, and verification of remote `main` before starting the next group.

## Risks

- Existing rendering expects filesystem paths. Keep a safe project-relative compatibility source alongside the asset ID.
- Atomic multi-file replacement can be interrupted. Journal before-images and recover before accepting the next command.
- The singleton job queue is imported widely. Preserve its synchronous mutation API while queuing durable writes and expose an explicit flush for tests/shutdown.
- Browser multipart limits may reject before service validation. Raise the transport limit to 2 GiB and retain per-file service checks.
- Host validation can break Fastify injection and proxies. Permit loopback variants and no-Origin non-browser clients while strictly checking browser mutation origins.

## Completion record

- [x] Slice 1 complete
- [x] Slice 2 complete
- [x] Slice 3 complete
- [x] Slice 4 complete
- [x] Slice 5 complete
- [x] Integrated verification complete (build, typecheck, 1,486 tests; workspace lint remains blocked by pre-existing errors in tracked code and nested worktrees, while changed foundation files pass ESLint)
