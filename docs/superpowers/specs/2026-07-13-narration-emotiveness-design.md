# Narration Emotiveness (light / medium / heavy) — Design

**Date:** 2026-07-13
**Status:** Approved (pending implementation)

## Summary

Add a per-scene **emotiveness level** — `light | medium | heavy` — to narration,
with a project-wide default. The level changes how the narration **actually
sounds**, applied at the TTS layer in an engine-aware way, because the two
supported engines expose expressiveness through completely different
mechanisms:

- **Gemini TTS** — a natural-language **style directive** prepended to the TTS
  prompt (Gemini controllable TTS). No inline tags.
- **xAI (Grok) TTS** — emotion is controlled **exclusively by inline/wrapping
  tags** in the text (there is no emotion/style field on `/v1/tts`). Heavier
  levels insert more xAI-native markup via an LLM pass.

## Background: why tags alone don't work today

Every TTS provider currently **strips all bracket tags before synthesis**
(`stripEmotiveTags`, e.g. `apps/server/src/services/tts/providers/gemini.ts`),
so the app's emotive tags (`[warm]`, `[confident]`, …) never reach any engine
and have **no effect on the audio**. Simply inserting more `[warm]` tags would
be cosmetic. This feature makes emotiveness affect the audio for real.

Per the [xAI TTS docs](https://docs.x.ai/developers/model-capabilities/audio/text-to-speech):

- **Inline tags:** `[pause]`, `[long-pause]`, `[laugh]`, `[cry]`, `[smack]`,
  `[click]`, `[inhale]`, `[exhale]`.
- **Wrapping tags:** `<emphasis>…</emphasis>`, `<strong>`, `<soft>`, `<slow>`,
  `<fast>`, `<high>`, `<low>`, `<whisper>`, `<singing>`.
- Emotion is controlled **only** through these tags — no natural-language
  instruction, no emotion parameter.
- `text` max is **15,000 chars** (chunks are per-paragraph, far under).

Gemini, by contrast, honours a natural-language style instruction in the prompt
and does **not** use inline tags.

## Decisions (locked during brainstorming)

1. **What the level changes:** the actual audio, engine-aware.
2. **Scope:** per-scene control **plus** a project-wide default that scenes
   inherit until overridden.
3. **xAI mechanism:** an **LLM pass inserts** xAI-native tags at generation
   time (natural placement, denser at heavier levels).
4. **Default level:** `medium` (project default; freely changeable).
5. **xAI pass always-on** for the xAI engine when a level is set (batched per
   scene generation) — not opt-in.
6. **Ship both engines together.**

## Non-goals

- Changing how scripts are *written* (the narration-writer / polish prompts and
  the app's `[warm]`-style tags are unchanged). Emotiveness is a TTS-layer
  concern, so changing it re-runs only TTS, not the script.
- Using xAI's `with_timestamps` for real word timings (noted as a future
  accuracy win; out of scope).
- Expressiveness for `fake` / `qwen` engines (they ignore the level gracefully).

## Levels

`type Expressiveness = 'light' | 'medium' | 'heavy'`

Effective level for a scene = `scene.narration.tts.expressiveness ??
storyboard.defaults.tts_expressiveness ?? 'medium'`.

## Data model

- `NarrationSchema.tts` (in `packages/shared/src/storyboard.ts`) gains
  `expressiveness: z.enum(['light','medium','heavy']).optional()`.
- `StoryboardDefaultsSchema` gains
  `tts_expressiveness: z.enum(['light','medium','heavy']).optional()`.
- No migration needed — both optional, absent ⇒ `medium`.

## Backend

### TTS interface
`TtsGenerateOpts` (in `apps/server/src/services/tts/provider.ts`) gains
`expressiveness?: Expressiveness`.

### Engine application

**Gemini** (`providers/gemini.ts`):
- Build a style directive from the level and prepend it to the prompt text
  (still strip the app's inline tags as today). Directives:
  - `light`  → `Read this in a natural, lightly expressive tone.`
  - `medium` → `Read this with clear warmth and expression, emphasizing the key moments.`
  - `heavy`  → `Read this with strong, animated emotion and energy — lean into emphasis, warmth, and dynamic pacing.`
- Format: `"<directive>\n\n<cleanText>"`. A `medium`-or-absent default still
  passes a mild directive. Implementation must verify (see Testing) that the
  directive is applied as *style* and not spoken aloud.

**xAI** (`providers/xai.ts`):
- Stop the blanket strip. Instead strip **only the app's emotive words**
  (`warm|confident|thoughtful|calm|excited|curious|serious|friendly|
  professional|enthusiastic`) as `[word]`, and **preserve** every xAI tag —
  both inline `[pause]`/`[laugh]`/… and all `<...>` wrapping tags.
- The provider does **not** call the LLM; the xAI tags are inserted upstream
  (narration service) so the provider just passes the prepared text through.
- Ignores `expressiveness` itself (already materialised as tags).

**fake / qwen:** ignore `expressiveness`.

### Expressiveness preparation (new)
`apps/server/src/services/tts/expressiveness.ts`:

- `geminiStyleDirective(level): string` — pure, the mapping above.
- `stripAppEmotives(text): string` — remove only the app's known emotive
  `[word]` tags; leave xAI tags and prose intact. Used by the xAI provider.
- `prepareExpressiveText({ text, engine, level, llm }): Promise<string>`:
  - engine `xai` → run the LLM insertion pass (below) and return the tagged
    text. On any failure, **return the original text** (log a warning) so
    synthesis still succeeds.
  - any other engine → return `text` unchanged.

### xAI insertion LLM pass
- Prompt `prompts/narration-expressiveness-xai.md`. System role: an audio
  director that adds xAI Grok TTS markup to demo-video narration.
  - May only add tags from the xAI vocabulary; **must not** change, add, or
    remove words.
  - Steer toward narration-appropriate tags — `[pause]`, `[long-pause]`,
    `<emphasis>`, `<strong>`, `<soft>`, `<slow>` — and avoid gimmicky ones
    (`[laugh]`, `[cry]`, `[smack]`, `[click]`, `<singing>`, `<whisper>`,
    `<high>`, `<low>`) unless the text clearly calls for them.
  - Density by level: `light` = sparse (a few emphases, the odd pause);
    `medium` = moderate; `heavy` = liberal emphasis + pacing + pauses.
  - Return ONLY the marked-up text, no commentary.
- The pass first strips any residual app emotive tags from the input so the
  model sees clean prose to annotate.

### Wiring
`apps/server/src/services/narration/index.ts` — `generateNarration`,
`generateChunkNarration`, `generateAllChunks` gain `expressiveness` and an
`llm` client, and before `tts.generate(...)` call
`prepareExpressiveText(...)`, then pass `expressiveness` in the opts. The
narration route (`apps/server/src/routes/narration.ts`) already has the `llm`
dependency and threads the level from the request; it resolves the effective
level (scene ?? project default ?? medium) and persists the chosen level in
`scene.narration.tts.expressiveness`.

## Client / UX

- **Scene → Narration tab** (`apps/web/src/pages/ScenePage.tsx`): a
  `Light · Medium · Heavy` segmented control beside engine/voice/speed. Shows
  "(project default)" affordance until the scene overrides it. Sent with the
  generate request and saved to `narration.tts.expressiveness`.
- **Project `/narration` page** (`apps/web/src/pages/NarrationPage.tsx`): a
  project-default control writing `defaults.tts_expressiveness`.
- Changing the level **marks that scene's TTS chunks stale** (same UX as
  editing a script) so the user knows to regenerate to hear it. (Reuses the
  existing chunk-staleness surfacing; a level change does not silently keep old
  audio.)
- `web/src/lib/api.ts` — `RenderOptions`-style narration generate calls gain
  `expressiveness`; the shared `Expressiveness` type is exported from
  `@vpa/shared`.

## Error handling

| Case | Handling |
|---|---|
| xAI insertion LLM pass errors | Fall back to the untransformed text; synthesize anyway; log a warning. |
| Unknown / missing level | Treat as `medium`. |
| Engine without expressiveness support (fake/qwen) | Ignore the level; behaviour unchanged. |
| Gemini directive risk (spoken aloud) | Verified during implementation with a real sample; adjust directive framing if needed. |

## Testing

- `geminiStyleDirective(level)` → returns the exact directive per level
  (`light`/`medium`/`heavy`).
- `stripAppEmotives` → removes `[warm]`/`[confident]` but **keeps** `[pause]`,
  `[inhale]`, and `<emphasis>…</emphasis>`.
- `prepareExpressiveText` with a fake LLM:
  - `engine: 'xai', level: 'heavy'` → returns text containing inserted xAI
    markup.
  - `engine: 'gemini'` → returns the text unchanged (no LLM call).
  - LLM throws → returns the original text (no throw).
- Schema: `narration.tts.expressiveness` and `defaults.tts_expressiveness`
  round-trip through save/load; absent ⇒ effective `medium`.
- Narration route: generating with a level persists it on the scene and
  passes it through to synthesis (fake engine asserts the opt is threaded).
- End-to-end verification (manual, during impl): a real Gemini generation at
  `heavy` audibly differs from `light` and does not speak the directive; an xAI
  generation contains xAI tags in the synthesized text path.

## Files touched

- `packages/shared/src/storyboard.ts` (+ index export of `Expressiveness`)
- `apps/server/src/services/tts/provider.ts`
- `apps/server/src/services/tts/expressiveness.ts` (new) + test
- `apps/server/src/services/tts/providers/gemini.ts`
- `apps/server/src/services/tts/providers/xai.ts`
- `apps/server/src/services/narration/index.ts`
- `apps/server/src/routes/narration.ts`
- `prompts/narration-expressiveness-xai.md` (new)
- `apps/web/src/lib/api.ts`
- `apps/web/src/pages/ScenePage.tsx`
- `apps/web/src/pages/NarrationPage.tsx`

## Open questions

None blocking. `with_timestamps`-based timings and expressiveness for
qwen/fake are explicit non-goals for this version.
