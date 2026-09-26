# Visual effects and source evidence implementation plan

## Contract

Implement `docs/superpowers/specs/2026-09-25-visual-evidence-design.md` and close #94 and #95 as one independently shippable group.

## Slices

1. Add strict shared visual-effect, transcript, evidence, composition-mapping, and SRT contracts.
2. Add atomic revision commands and asset/clip/source-time validation.
3. Build deterministic effect filters in the shared composition renderer with explicit stage order and capability preflight.
4. Add Gemini-routed immutable-source transcription/evidence caching, corrections, SRT, frames, contact sheets, and bounded excerpts.
5. Add the persistent visual/evidence editor with direct add, shared selection, drag/numeric geometry, focused timeline, dirty protection, search, corrections, and evidence actions.
6. Run targeted and full verification, publish, inspect CI, and merge before starting the review-loop group.

## Completion record

- [x] Slice 1
- [x] Slice 2
- [x] Slice 3
- [x] Slice 4
- [x] Slice 5
- [x] Slice 6
