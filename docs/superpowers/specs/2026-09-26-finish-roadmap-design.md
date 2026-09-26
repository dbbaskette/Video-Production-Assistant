# Finish the VPA roadmap

## Outcome

Complete the four remaining implementation issues in three independently shippable groups, then close the roadmap only after the integrated suite and issue acceptance checks pass.

## Group 1: editable, version-pinned brand kits (#28)

- Add a no-model manual creation path with a useful validated starter kit.
- Make the compact visual editor the primary edit surface; keep structured markdown as an advanced view.
- Persist an immutable design snapshot for every brand version. Project `applied_version` resolves that snapshot, so later library edits never silently change an accepted project.
- Store uploaded assets under immutable content-addressed names and retain files referenced by prior versions.
- Expose version history, affected projects, validation, and explicit project upgrade/rollback operations.
- Add editable production defaults for captions, callouts, lower thirds, narration, bumpers and music. Downstream editors/rendering read the pinned effective kit.
- Surface missing referenced assets and unavailable browser fonts before render.

## Group 2: evidence-driven editorial and polish proposals (#9, #22)

- Add shared schemas for source-cited proposals. A proposal records source interval, rationale, confidence, provenance, review state and the exact canonical commands it would apply.
- Build deterministic, reviewable target-duration proposals from composition clips and timed transcript passages. Preserve linked tracks by trimming/splitting primary clip instances through existing commands.
- Explain target-duration tradeoffs, including when evidence cannot safely meet the requested tolerance. Never fabricate continuity or claim frame accuracy.
- Add transcript-selection cut/highlight proposals and retain existing word correction as the text edit path.
- Add bounded focus/callout/sensitive-content proposals from available transcript/visual evidence. Metadata-backed observations and inferences remain distinct.
- Nothing mutates until the user accepts a proposal. Acceptance uses one revision-aware idempotent command batch; restore remains the existing revision operation.
- Add preview UI for omissions, evidence, collisions and unresolved sensitive-content review.

## Group 3: independent output variants (#104)

- Persist project-local variant definitions with independent IDs, source revision, aspect ratio, crop mode/focus, safe-area margins, selected ranges and optional locale/caption overrides.
- A variant never mutates the base storyboard. It becomes stale when the accepted project revision advances and upgrades only through an explicit rebase.
- Render requests may name a variant. Finalization emits the requested 16:9, 1:1 or 9:16 dimensions and applies contain or explicit focus crop without replacing another artifact.
- Render manifests record the variant, aspect ratio, dimensions, source revision and localization provenance.
- Validate caption expansion, safe areas, webcam/effect/redaction bounds and missing localized narration before render. Failure leaves base and prior variants intact.
- Approved highlight ranges from the editorial proposal surface can seed a clip variant.

## Shared boundaries

- Preserve immutable source media, accepted revisions and existing projects.
- Extend the shared command/service layer; do not add another editor or business-logic layer in MCP.
- Model assistance creates proposals only. Apply, upgrade, rebase, render and delete actions are explicit and idempotent.
- Provider failures and incomplete evidence remain visible and cannot mark work accepted.
- Existing projects and brand kits migrate lazily and reversibly.

## Completion

- Each group has focused server/shared/web tests and a merged PR closing its implementation issue(s).
- The final tree passes the full relevant test, typecheck and build suites.
- Roadmap #88 is refreshed and closed only when no implementation issues remain.
