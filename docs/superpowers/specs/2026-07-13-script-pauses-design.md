# Script Pauses / Timing + AI-Review Guidance — Design

**Date:** 2026-07-13
**Status:** Approved (pending implementation)

## Summary

Let the author insert deliberate **pauses** into narration so it can be paced
to on-screen action — especially useful for a single long scene. A pause is a
span of **silence** inserted between narration chunks at concat time (not baked
into any chunk's audio), so it is engine-agnostic and cheap to change.

Two authoring paths (both):
- An inline **`[pause 1.5s]`** token in the script.
- A per-chunk **"Gap after (s)"** field on the Narration tab.

The AI **Quality Review** explains the `[pause 1.5s]` syntax when a scene would
benefit from pacing (a single long scene, or narration much shorter than its
recording — dead air).

## Background (current pipeline)

- Chunks are one-paragraph-per-MP3, split by blank lines (`splitIntoParagraphs`)
  or per-speaker (`splitDialogIntoChunks`).
- The per-scene audio is assembled by concatenating chunk MP3s **end-to-end
  with zero gap** at two sites: `apps/server/src/services/render/scene-render.ts`
  (`prepareNarrationAudio`) and `apps/server/src/services/render/index.ts`
  (`prepareSceneAudio`).
- `NarrationChunkSchema` has no gap field. There is **no** pause support today,
  and a hand-typed `[pause 1.5s]` would be spoken aloud by the TTS engine.
- Per-scene combined subtitles are only assembled in the legacy single-file
  `generateNarration` path; the chunked path (the modern default) stores
  per-chunk `timings` but does not assemble a combined `subtitles.srt`. So
  chunked-path subtitle timing is unaffected by this feature (see Non-goals).

## Decisions (locked during brainstorming)

1. **Mechanism:** inter-chunk silence at concat time via a per-chunk `gapSec`.
2. **Authoring:** both — inline `[pause 1.5s]` token AND a per-chunk UI field.
3. **AI review:** explain the syntax when relevant (info/suggestion). No
   one-click proposer.
4. **Bare `[pause]` in a script** is left to the xAI expressive path (from the
   emotiveness feature); only `[pause <duration>]` is a timed pause here.
5. **Scope:** pauses/silence only — not timestamp-anchored sync.

## Token syntax

`[pause <seconds>]` — e.g. `[pause 1.5s]`, `[pause 0.8s]`, `[pause 2]`.

- Regex: `/\[pause\s+(\d+(?:\.\d+)?)\s*s?\]/gi`.
- Duration clamped to **0.1–10s**. A match with an out-of-range or unparseable
  duration is stripped from the text and contributes **no** gap (fails safe).
- A **bare** `[pause]` (no number) is NOT matched here — it belongs to the xAI
  expressive path.

## Data model

`NarrationChunkSchema` (in `packages/shared/src/storyboard.ts`) gains:

```
gapSec: z.number().nonnegative().optional()   // trailing silence after this chunk
```

`chunk.gapSec` is the stored source of truth. Absent ⇒ 0 (today's behavior).

## Pause parser (new)

`apps/server/src/services/narration/pause-parser.ts`:

- `parsePauses(text: string): { text: string; gapSec: number }[]`
  - Splits `text` into segments on `[pause <dur>]` tokens.
  - Each segment before a token becomes `{ text, gapSec: <dur> }`; the trailing
    remainder becomes `{ text, gapSec: 0 }`.
  - Strips the tokens from `text`; trims; drops empty-text segments **but keeps
    their gap** by folding it onto the previous segment (so `[pause 1s][pause 1s]`
    → a single 2s gap, and a leading token folds into the first real segment as
    a leading gap is dropped — leading silence before any speech is not
    emitted).
- A sibling `splitScriptIntoChunks(script): { text, gapSec }[]` composes the
  existing blank-line/dialog split with `parsePauses`. **Every site that derives
  chunk boundaries from the script must use this one splitter** so indices/text
  stay aligned — namely `generateAllChunks` (chunk generation), `markChunkFailed`
  (failure stubs), and the `GET …/narration` route (chunk info for the UI). The
  original `splitIntoParagraphs` stays for any pause-agnostic caller, but all
  chunk-derivation switches to the pause-aware splitter.

The token is removed from chunk `text` before it is ever sent to TTS.

**Chunk (re)derivation + stale detection:** `generateAllChunks` already
re-derives chunk boundaries from the script and compares stored `text` to the
derived paragraph to detect drift. It will compare the derived `{text, gapSec}`
and treat a changed gap the same as changed text for the purpose of
re-deriving — but because gaps are applied at concat (not baked into audio), a
gap-only change does **not** force TTS regeneration of that chunk; it only
updates the stored `gapSec`.

## Silence at concat + duration accounting

- Add a helper `buildSilenceClip(dir, gapSec)` that renders (and caches by
  duration) a mono MP3 of `gapSec` silence via
  `ffmpeg -f lavfi -i anullsrc=r=44100:cl=mono -t <gapSec> -c:a libmp3lame`.
- At both concat sites, interleave `file '<silence>.mp3'` entries after any
  chunk whose `gapSec > 0`. The concat output already re-encodes to libmp3lame;
  normalize `-ar 44100 -ac 1` so mixed-rate inputs concat cleanly. On silence
  generation failure, log and fall back to the gapless list (never block a
  render).
- **Duration accounting:** `totalNarrationDuration(scene)` (and any other
  narration-duration computation feeding the length check / freeze-pad) sums
  `gapSec` in addition to chunk `durationSec`, so "narration vs recording"
  verdicts and video freeze-padding remain accurate.

## Quality Review guidance

- `prompts/quality-review.md`: add a **pacing** guidance block — when a scene is
  a single long scene, or its narration is meaningfully shorter than the
  recording (leaving dead air), emit a suggestion to add `[pause 1.5s]` at the
  desired beats, quoting the exact syntax. Use `category: "pacing"`, severity
  `info` (or `warn` for large dead-air gaps). Do NOT flag scenes that already
  fit or already use pauses.
- `apps/server/src/services/quality-review/index.ts` (`buildStoryboardContext`):
  surface per-scene recording duration vs. narration duration (incl. gaps) so
  the model can detect dead air. Add `pacing` to the allowed category set.
- UI simply renders the message (the review list already renders arbitrary
  `{severity, category, message}` items). No new button.

## Client / UX

- **Scene → Narration tab** (`apps/web/src/pages/ScenePage.tsx`): each chunk row
  gains a compact **"Gap after (s)"** number input bound to `chunk.gapSec`,
  saved via a small PUT (see API). A short legend near the script editor
  documents the `[pause 1.5s]` token.
- **Save path:** a `PUT …/narration/chunks/:index/gap` (or fold into an existing
  chunk-save endpoint) persists `gapSec` on the chunk without regenerating
  audio. Web `narrationApi.setChunkGap(projectId, sceneId, index, gapSec)`.
- Changing a gap shows no "stale audio" warning (audio is unaffected); a small
  note clarifies gaps apply on the next render/preview.

## Defensive stripping

- The chunker strips `[pause <dur>]` before TTS. As belt-and-suspenders, the TTS
  providers' text-prep also strips a stray `[pause \d…]` so a leftover can never
  be vocalized. (Bare `[pause]` is deliberately left intact for xAI.)

## Error handling

| Case | Handling |
|---|---|
| Malformed / out-of-range duration | Token stripped, no gap (fail safe). |
| No tokens / no gaps | Identical to today (gapless concat). |
| Silence-clip generation fails | Log; concat without that gap; render still succeeds. |
| Leading `[pause]` before any speech | Dropped (no leading silence). |
| Mixed-engine chunks (dialog) | Concat re-encode + `-ar/-ac` normalize handles it. |

## Testing

- `parsePauses`: token → boundary + gapSec; token stripped from text;
  mid-paragraph split; `[pause 2]`/`[pause 1.5s]` both parse; malformed ignored;
  consecutive tokens fold; leading token drops.
- Chunker returns `{text, gapSec}` with gaps seeded from tokens.
- Concat: a scene with gaps produces audio whose duration ≈ Σ(chunk durations)
  + Σ(gaps) (ffprobe assertion; fake/short clips).
- `totalNarrationDuration` includes gaps.
- Schema: `chunk.gapSec` round-trips through save/load.
- Route: setting a chunk gap persists it without touching audio.

## Non-goals

- Timestamp-anchored narration sync (only relative pauses).
- Chunked-path combined subtitle assembly / offsetting (not built today;
  unchanged here).
- Pauses in the legacy single-file `generateNarration` path (the modern chunked
  path is the default; tokens there are simply stripped).
- A one-click "insert pauses" proposer in Quality Review.

## Files touched

- `packages/shared/src/storyboard.ts`
- `apps/server/src/services/narration/pause-parser.ts` (new) + test
- `apps/server/src/services/narration/index.ts` (chunkers + duration)
- `apps/server/src/services/render/scene-render.ts`, `render/index.ts` (concat + silence)
- a silence-clip helper (in render or a shared audio util) + test
- `apps/server/src/services/quality-review/index.ts` + `prompts/quality-review.md`
- `apps/server/src/routes/narration.ts` (+ web `api.ts`) for the gap PUT
- `apps/web/src/pages/ScenePage.tsx` (per-chunk gap field + legend)

## Open questions

None blocking.
