---
name: vpa-agent-recording
description: Use when VPA directly dispatches a supported macOS scene rehearsal or confirmed recording turn to Codex CLI.
---

# Operate a VPA Recording Scene

## Core contract

Use the reviewed plan embedded by VPA as the complete authority. Use only `scripts/vpa-desktop-driver.mjs` for all GUI operations. VPA owns setup, capture, confirmation, local export, attachment, and session coordination.

## Hard boundaries

- Never run `cap` or interact with Cap.
- Never upload or attach recordings.
- Never change VPA session state or call VPA APIs.
- Never operate another app; the driver capability is bound to the approved target.
- Never edit repository files, access secrets, publish, communicate externally, or perform destructive actions.
- Do not fetch or reconstruct a plan. If the embedded plan or driver environment is missing, return failed evidence.

## Desktop driver

Run `node scripts/vpa-desktop-driver.mjs --help`. Operations: `inspect`, `screenshot`, `click`, `set-value`, `type-text`, `press-key`.

Inspect before each action; indexes expire after visible changes. Screenshots verify only the approved window. A refusal is a hard stop.

## Rehearsal turn

1. Inspect the approved target against the embedded plan.
2. Rehearse every action and checkpoint without capture.
3. Reset the starting state and inspect again.
4. Return only this JSON shape; `detail` and `diagnostic` are required and may be `null`:

```json
{
  "success": true,
  "targetApplication": "MeetingNotes",
  "windowTitle": "MeetingNotes — Settings",
  "windowBounds": { "x": 0, "y": 0, "width": 1512, "height": 982 },
  "completedStepIndexes": [0, 1, 2],
  "checkpoints": [{ "description": "Expected state", "passed": true, "detail": null }],
  "resetConfirmed": true,
  "diagnostic": null
}
```

Set `success` false on any action, checkpoint, target, or reset failure. List only completed indexes; keep `diagnostic` concise and non-secret.

Failed evidence must still match the schema. Never omit fields, null non-nullable fields, or invent observations. Recover missing evidence by rechecking the approved target through the driver. If any required value remains unavailable, do not claim a structured result; let the turn fail.

## Resumed recording turn

When VPA resumes the thread after confirmation, execute only the rehearsed actions once, in order. Do not improvise or rehearse again. Return only this execution evidence JSON; `detail` may be `null`, while `diagnostic` is a string:

```json
{
  "success": true,
  "completedStepIndexes": [0, 1, 2],
  "checkpoints": [{ "description": "Expected state", "passed": true, "detail": null }],
  "diagnostic": "All rehearsed actions and checkpoints completed."
}
```

On deviation, stop target actions and return failed execution evidence. VPA decides what happens to the take.

## Common mistakes

| Mistake                              | Required response          |
| ------------------------------------ | -------------------------- |
| Missing embedded plan or capability  | Return failed evidence     |
| Stale element index                  | Inspect again              |
| Target differs from the plan         | Stop; do not switch apps   |
| Driver refuses an action             | Stop; do not bypass it     |
| Asked to manage capture or VPA state | Refuse that responsibility |

The [troubleshooting handoff](references/handoff-template.md) is diagnostic fallback only, not the recording workflow.
