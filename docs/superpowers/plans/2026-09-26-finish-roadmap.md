# Finish the VPA roadmap implementation plan

## 1. Brand kits (#28)

- Extend brand schemas with production defaults and version metadata.
- Add immutable design snapshots, content-addressed assets, version reads, validation and manual creation in the brand service/routes.
- Make render and project brand summaries resolve the pinned version.
- Add compact create/edit/history/validation/usage UI with explicit upgrade and rollback.
- Verify migration behavior, missing assets, affected projects and project pinning.
- Publish and merge a PR closing #28.

## 2. Evidence-driven editing (#9 and #22)

- Define editorial and visual suggestion schemas with source citations, confidence and provenance.
- Add pure proposal builders for target duration, transcript selections, callouts/focus and sensitive patterns.
- Add read/propose/apply APIs; apply only through revision-aware idempotent project commands.
- Add one review surface to inspect omissions/evidence, accept selected proposals and preserve unresolved warnings.
- Verify repeated phrases, uncertain words, pauses, linked tracks, transforms, stale revisions, retries and restore.
- Publish and merge one related PR closing #9 and #22.

## 3. Output variants (#104)

- Define and persist independent project variants and staleness/rebase metadata.
- Add variant CRUD, validation and explicit selected-range/localization configuration.
- Extend render finalization/manifests for variant dimensions, crop focus and provenance.
- Add variant management and safe-area/localization review UI.
- Verify independent artifacts, all aspect ratios, stale/rebase behavior, captions and failure preservation.
- Publish and merge a PR closing #104.

## 4. Roadmap closeout (#88)

- Run the full repository test suite, typecheck and production build on the integrated tree.
- Confirm no implementation issues remain open, update the roadmap completion record and close #88.

## Verification ownership

- Shared schemas/pure builders: unit tests.
- Persistence, revision, idempotency, migration and render contracts: server tests.
- Explicit review/accept/upgrade flows and accessibility: web component tests.
- Cross-group compatibility: root test/typecheck/build once on the final integrated tree.

## Progress

- [x] Brand kits merged (#28)
- [x] Evidence-driven editing implemented (#9, #22; merge tracked in PR)
- [x] Output variants implemented (#104; merge tracked in PR)
- [ ] Integrated verification complete and roadmap closed (#88)
