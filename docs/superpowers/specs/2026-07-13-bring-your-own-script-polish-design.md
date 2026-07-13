# Bring-Your-Own-Script Polish — Design

**Date:** 2026-07-13
**Status:** Approved (pending implementation plan)

## Summary

Today the Scene → Script tab only supports "AI writes the script from scratch"
(driven by the scene's intent / north-star field, optionally grounded in the
video). This feature adds a second input mode: the user pastes their **own**
script and the AI acts as an **editor** — it evaluates the draft, polishes it
(pacing, clarity, flow), adds the app's emotive tags, and fits it to the
recording length. The result is presented in a side-by-side review modal the
user accepts or rejects.

## Goals

- Let the user supply their own script instead of only describing the scene.
- Have the AI evaluate + editorially polish that script and add emotive tags.
- Fit the polished script to the recording duration using the project's
  measured words-per-minute rate.
- Present the result as a reviewable proposal (accept / reject), never a silent
  overwrite.

## Non-goals

- Replacing or changing the existing "describe → generate" flow (it stays as
  one of the two radio modes, unchanged).
- Auto-producing the dialog variant on accept. Polish targets the **monologue**
  script; the dialog variant is still created on demand via the existing
  convert flow, exactly as it works for a generated script today.
- Persisting the raw pasted draft across navigation (v1 keeps it as local
  editor state, like the intent draft).

## Decisions (locked during brainstorming)

1. **AI output presentation** — side-by-side review modal (original vs.
   proposed) with accept / reject, mirroring the existing `TightenScriptModal`.
2. **Edit scope** — editorial polish: add emotives **and** actively improve
   pacing, clarity, flow; rephrase, tighten, reorder. Treats the pasted script
   as a strong draft to elevate (not a fixed set of words to preserve verbatim).
3. **Mode model** — one radio at the top of the Script tab with two input
   modes; a single primary button adapts to the choice.
4. **Length fit** — yes, fit to the recording duration using the project's
   measured WPM (same source of truth as Generate + Tighten). When no recording
   exists, skip length-fitting and note it in the modal rather than blocking.

## Approach

Add a **dedicated polish path** — new prompt + service + endpoint + review
modal — rather than overloading the existing Tighten machinery. Tighten is
deliberately narrow ("remove content only, never rephrase"); polishing is the
opposite. The new review modal is **modeled on `TightenScriptModal`** so the
side-by-side review matches an existing pattern.

Alternatives considered and rejected:

- **Extend the Tighten endpoint/modal with a "polish" mode** — conflates two
  opposite behaviors (remove-only vs. rephrase-and-add) in one component/prompt.
- **Client-only: reuse Generate with the pasted draft injected** — weakens
  prompt quality (the write-from-scratch prompt is not an editor prompt) and
  skips the critique + structured length-fit.

## UX flow (Scene → Script tab)

A radio group at the top of the tab selects the input mode:

- **○ Describe the scene → AI writes it** *(default; today's flow)* — the
  existing "What is this scene demonstrating?" intent field, "Ground in video"
  toggle (Gemini only), and **Generate script** button, all unchanged.
- **○ I'll write the script → AI polishes it** *(new)* — a large **"Paste your
  script"** textarea appears. The intent field stays visible but is relabeled
  as *optional context for the polisher*. The primary button becomes **✨
  Evaluate & polish**, disabled until the paste box has non-whitespace content.

Clicking **Evaluate & polish** opens the **side-by-side review modal**:

- Left column: the user's original draft.
- Right column: the AI's polished version (accent border).
- A short **critique** — 2–5 bullets on what changed and why.
- Word-count stats: target for the recording / current / proposed, plus the
  WPM-is-measured note (identical framing to the Tighten modal).
- Buttons: **Cancel** (leaves the paste box untouched), **Try again** (re-roll),
  **Accept & save**.

**Accept & save** persists the polished text as the scene's monologue script via
the monologue save path (`narrationApi.saveScript(..., 'monologue')`), which
backs up the previous version (restore-previous) and clears stale TTS chunks.
The saved script then appears in the existing Monologue editor below.

## Polish behavior

- **Editorial polish**: preserve the user's meaning and factual claims, but
  improve pacing/clarity/flow, rephrase, tighten, reorder, and split into
  TTS-friendly short paragraphs (one idea per paragraph, blank-line separated).
- **Emotive tags**: insert tags from the app's standard vocabulary — `[warm]`,
  `[thoughtful]`, `[excited]`, `[confident]`, `[curious]`, `[calm]` — at the
  start of sentences/phrases. Normalize any stage directions the user pasted
  into this vocabulary.
- **Length fit**: target `round(durationSec / 60 * wpm)` words, where `wpm`
  comes from `computeProjectWpm()` (measured when TTS chunks exist, else the
  150 default). When the scene has **no recording** (no duration), skip the
  target and polish for quality + emotives only; the modal states that it was
  not fitted to length.

## Components and data flow

```
User (BYO mode) pastes draft, clicks "Evaluate & polish"
  → PolishScriptModal mounts, fires scriptApi.polish(projectId, sceneId, { draft })
  → POST /api/projects/:id/scenes/:sceneId/script/polish
      • load storyboard + scene
      • target duration = scene.recording?.duration_sec (optional)
      • wpm = computeProjectWpm(sb)
      • polishScript({ draft, targetDurationSec?, wpm, sceneName,
                       sceneIntent, projectObjective, projectAudience,
                       projectPath })
          - loadPrompt('narration-polish')
          - withReferenceContext(...) to inject source-docs (like Generate)
          - llm.complete(...) → JSON { notes: string[], script: string }
          - parse defensively (malformed → whole text as script, notes = [])
      • respond WITHOUT mutating storyboard.yaml
  → modal shows original vs proposed + notes + word stats
  → Accept: narrationApi.saveScript(projectId, sceneId, proposed, 'monologue')
      • backs up previous monologue, wipes stale TTS chunks
      • onAccepted() invalidates ['script', ...] / ['narration', ...] / storyboard
      • modal closes; editor shows the new script
```

### Server

- **`apps/server/src/services/script/polish.ts`**
  - `interface PolishInput { draft: string; targetDurationSec?: number;
    wpm?: number; sceneName?: string; sceneIntent?: string;
    projectObjective?: string; projectAudience?: string; projectPath?: string }`
  - `interface PolishResult { proposedScript: string; notes: string[];
    currentWords: number; targetWords?: number; proposedWords: number }`
  - `async function polishScript(input, llm, workspaceRoot): Promise<PolishResult>`
  - Computes `targetWords` only when `targetDurationSec` is present.
  - Uses a moderate temperature (~0.6 — editorial, not inventive).
  - Defensive JSON parse with a plain-text fallback.

- **Route** in `apps/server/src/routes/scripts.ts`:
  `POST /api/projects/:id/scenes/:sceneId/script/polish`
  - Body: `{ draft: string; targetDurationSec?: number }`.
  - `draft` missing/blank → 400 `no_draft`.
  - Resolves project path, loads storyboard/scene (404s reuse existing codes).
  - Computes wpm via `computeProjectWpm`.
  - Returns `{ sceneId, originalScript, proposedScript, notes, currentWords,
    targetWords, proposedWords, targetDurationSec, wpm, wpmIsMeasured,
    wpmSampleChunks }`.
  - LLM/parse failure → 500 `polish_failed` (like `/tighten`).
  - Does **not** call `saveStoryboard`.

- **Prompt** `prompts/narration-polish.md` — editorial-polisher system prompt.
  Reuses the emotive-tag vocabulary and paragraph-structure guidance from
  `narration-writer.md`. Instructs the model that the pasted draft is the
  primary content (preserve meaning + facts), the intent/objective/audience/
  source-docs are supporting context, and to hit the target word count when
  provided. Output contract: **JSON only** — `{ "notes": string[], "script":
  string }`.

### Client

- **`apps/web/src/lib/api.ts`** — add
  `scriptApi.polish(projectId, sceneId, { draft, targetDurationSec? })` →
  `POST .../script/polish` with a ~2 min timeout (matches `tighten`).

- **`apps/web/src/components/PolishScriptModal.tsx`** — new component modeled on
  `TightenScriptModal`. Props: `{ projectId, sceneId, sceneName, draft, onClose,
  onAccepted }`. On mount fires the polish mutation. Renders word stats, the
  critique notes list, side-by-side Original/Polished columns, and Cancel /
  Try again / Accept & save. Accept uses the monologue save path and calls
  `onAccepted` then `onClose`. Includes the "saving clears TTS chunks" footer.

- **`apps/web/src/pages/ScenePage.tsx`** (Script tab) — add:
  - state: `scriptInputMode: 'describe' | 'byo'` (default `'describe'`),
    `draftScript: string`, `polishModalOpen: boolean`.
  - radio group above the intent field.
  - BYO mode: paste textarea + "Evaluate & polish" button (disabled when blank);
    hide the "Ground in video" toggle (not relevant to polish).
  - describe mode: unchanged intent field + generate button.
  - modal wiring + cache invalidation on accept (same query keys the generate
    flow invalidates).

## Error handling

| Case | Handling |
|---|---|
| Empty / whitespace draft | Button disabled; server 400 `no_draft` as backstop. |
| No recording (no duration) | Polish runs without a length target; modal notes it wasn't fitted to length. |
| Malformed LLM JSON | Parse falls back to treating the whole response as the script, `notes = []`. |
| LLM / network failure | 500 `polish_failed`; surfaced in the modal (with Try again), like Tighten. |
| Save failure on Accept | Surfaced in the modal; script not changed. |

## Testing

- **Server unit** (`polish.ts`) with a fake LLM:
  - Valid JSON response → parsed `notes` + `script`, correct word counts.
  - Malformed response → plain-text fallback, `notes = []`.
  - `targetWords` computed from `durationSec × wpm` when duration present.
  - No-duration input → `targetWords` undefined, no target injected in prompt.
- **Route test** (`/polish`):
  - Returns a proposal and does **not** mutate `storyboard.yaml`.
  - Empty draft → 400 `no_draft`.
- **Client** — follow existing patterns for the tab wiring (radio switches the
  visible input; Evaluate & polish disabled when the paste box is blank).

## Open questions

None blocking. Dialog-on-accept and draft persistence are explicit non-goals
for v1 and can be revisited if the workflow warrants it.
