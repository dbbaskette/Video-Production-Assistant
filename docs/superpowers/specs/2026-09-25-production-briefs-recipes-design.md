# Editable production briefs, proposals, and draft recipes

Projects gain a versioned production brief with explicit defaults: purpose, audience, target duration, aspect ratio, tone, and optional basic brand. Brief edits use the project revision system so they are durable, attributable, and restorable without touching media.

Ideation sessions move from process memory into `.vpa/ideation.json`. Proposed scenes can be added, renamed, reordered, or removed through validated operations before acceptance. Acceptance uses revision commands, reports whether it will create or replace the storyboard, and preserves source-backed scenes that are not explicitly replaced. Chat refinement continues against the edited proposal.

Three bounded recipes share one orchestration contract: `clean-walkthrough`, `feature-demo`, and `revise-this-draft`. A recipe inspects the current storyboard and immutable asset manifest, refuses unsupported or missing inputs with recoverable diagnostics, records the exact source/revision plan, and dispatches the existing revision-correct render path. The returned job points to a playable artifact rather than a plan-only completion.

The five-project pilot is a checked-in, machine-readable evaluation matrix and runner contract covering narrated walkthrough, screen-only feature demo, webcam demo, imported take, and multi-clip redaction. Results record hands-on effort, editorial accuracy, target-length tradeoffs, omissions, browser/device versions, feedback revision, restore revision, and playable artifact identity.
