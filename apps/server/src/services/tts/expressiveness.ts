/**
 * Narration emotiveness — engine-aware helpers.
 *
 * The two TTS engines expose expressiveness through completely different
 * mechanisms, so the level (light/medium/heavy) is materialised differently:
 *
 *   - Gemini: a natural-language style directive prepended to the prompt
 *     (`geminiStyleDirective`). Handled inside the Gemini provider.
 *   - xAI: inline/wrapping tags in the text — there is no emotion field on
 *     Grok's `/v1/tts`. `prepareExpressiveText` runs an LLM pass that inserts
 *     xAI-native tags at the requested density; the xAI provider then keeps
 *     those tags instead of stripping them.
 *
 * `stripAppEmotives` removes only the app's own emotive words (`[warm]`,
 * `[confident]`, …) — never xAI's expressive tags.
 */

import type { LlmClient } from '../llm/index.js';
import { loadPrompt } from '../llm/index.js';
import type { Expressiveness } from '@vpa/shared';

/** The app's script-authoring emotive vocabulary — cues for humans, not any
 *  TTS engine. These are the ONLY `[word]` tags we strip; xAI tags like
 *  `[pause]` / `[inhale]` are preserved. */
const APP_EMOTIVES = [
  'warm', 'thoughtful', 'excited', 'confident', 'curious', 'calm',
  'serious', 'friendly', 'professional', 'enthusiastic',
] as const;

const APP_EMOTIVE_RE = new RegExp(`\\[(?:${APP_EMOTIVES.join('|')})\\]\\s*`, 'gi');

/** Remove the app's emotive `[word]` tags, preserving all other text and any
 *  xAI expressive tags. */
export function stripAppEmotives(text: string): string {
  return text.replace(APP_EMOTIVE_RE, '').trim();
}

/** Strip every xAI expressive tag — inline `[pause]` and wrapping `<emphasis>…`
 *  — leaving just the spoken words. Used to build the word list for timings /
 *  subtitles so tags never leak into captions. */
export function stripXaiTags(text: string): string {
  return text
    // wrapping tags: <emphasis>, </soft>, and any stray attributes the model
    // might hallucinate (<slow rate="0.8">)
    .replace(/<\/?[a-z][a-z-]*(?:\s[^>]*)?>/gi, '')
    .replace(/\[[\w-]+\]/g, '')          // inline tags: [pause], [long-pause], …
    .replace(/\s+/g, ' ')
    .trim();
}

/** Natural-language style directive for Gemini controllable TTS, keyed to the
 *  emotiveness level. Prepended to the prompt so delivery is more/less
 *  expressive. */
export function geminiStyleDirective(level: Expressiveness): string {
  switch (level) {
    case 'light':
      return 'Read this in a natural, lightly expressive tone.';
    case 'heavy':
      return 'Read this with strong, animated emotion and energy — lean into emphasis, warmth, and dynamic pacing.';
    case 'medium':
    default:
      return 'Read this with clear warmth and expression, emphasizing the key moments.';
  }
}

export interface PrepareExpressiveTextInput {
  text: string;
  engine: string;
  level: Expressiveness;
  llm: LlmClient;
  workspaceRoot: string;
}

/**
 * Materialise the emotiveness level into the text where the engine needs it in
 * the text itself (xAI). For every other engine the text is returned unchanged
 * — Gemini applies its directive inside the provider, and fake/qwen ignore
 * expressiveness entirely.
 *
 * The xAI pass is best-effort: if the LLM call fails, we return the original
 * (app-emotive-stripped) text so synthesis still succeeds.
 */
/** xAI's documented, narration-safe tags. Non-documented tags (e.g.
 *  `<emphasis>`, `<strong>`) make xAI prepend framing words ("Say …"), so we
 *  hard-enforce this allowlist regardless of what the LLM produced. */
const ALLOWED_XAI_TAGS = new Set(['pause', 'long-pause', 'slow', 'fast', 'soft', 'whisper']);

/** Remove any xAI tag NOT in the allowlist, keeping the inner text of wrapping
 *  tags. Belt to the prompt's suspenders: a misbehaving model can't slip a
 *  `<emphasis>` through to xAI. */
export function keepAllowedXaiTags(text: string): string {
  return text
    .replace(/<\/?([a-z][a-z-]*)\s*>/gi, (m, name: string) =>
      ALLOWED_XAI_TAGS.has(name.toLowerCase()) ? m : '')
    .replace(/\[([a-z][a-z-]*)\]/gi, (m, name: string) =>
      ALLOWED_XAI_TAGS.has(name.toLowerCase()) ? m : '')
    .replace(/[^\S\n]+/g, ' ')
    .trim();
}

/**
 * Ensure the text starts with a real WORD, not a tag. xAI's /v1/tts emits a
 * fallback utterance ("Say something random…") when the input BEGINS with
 * markup — verified via STT (leading `<slow>` → framing 4/6; word-first → 5/5
 * clean). Strips leading inline tags and leading open wrapping tags (dropping
 * the matching close so nothing is left unbalanced) plus any orphan leading
 * close tag.
 */
export function ensureLeadingWord(text: string): string {
  let s = text.replace(/^\s+/, '');
  for (;;) {
    let m = s.match(/^\[[a-z][a-z-]*\]\s*/i); // leading inline tag
    if (m) { s = s.slice(m[0].length); continue; }
    m = s.match(/^<\/[a-z][a-z-]*\s*>\s*/i); // orphan leading close tag
    if (m) { s = s.slice(m[0].length); continue; }
    m = s.match(/^<([a-z][a-z-]*)\s*>\s*/i); // leading open wrapping tag
    if (m) {
      s = s.slice(m[0].length).replace(new RegExp(`</${m[1]}\\s*>`, 'i'), '');
      continue;
    }
    break;
  }
  return s.replace(/^\s+/, '');
}

/** Word-level signature: tags removed, lowercased, punctuation dropped. Two
 *  texts with the same signature say the same WORDS (differing only in tags). */
function wordSignature(text: string): string {
  return stripXaiTags(text)
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function prepareExpressiveText(
  input: PrepareExpressiveTextInput,
): Promise<string> {
  // Only xAI needs tags materialised in the text — its /v1/tts HONORS inline
  // tags ([pause], <slow>, <whisper>, …), verified via STT (they change
  // delivery, they are not spoken). Gemini applies the level via a style
  // directive in its provider; other engines ignore it.
  if (input.engine !== 'xai') {
    return input.text;
  }

  // Clean prose to annotate — drop app emotive cues first.
  const clean = stripAppEmotives(input.text);
  try {
    const systemPrompt = await loadPrompt(input.workspaceRoot, 'narration-expressiveness-xai');
    const userPrompt = `Requested level: ${input.level}\n\nNarration:\n${clean}`;
    const result = await input.llm.complete({ systemPrompt, userPrompt, temperature: 0.4 });
    const out = result.text.trim();
    if (out.length === 0) return clean;

    // GUARD: the pass may only ADD tags, never change words. A weak/local model
    // can prepend a preamble or reword — which xAI would then SPEAK ("words not
    // in the script"). If the tag-stripped output doesn't match the input words,
    // discard it and use the clean text.
    if (wordSignature(out) !== wordSignature(clean)) return clean;
    // Enforce the documented-tag allowlist, then guarantee a leading word so
    // xAI doesn't emit its "Say something random" framing fallback.
    return ensureLeadingWord(keepAllowedXaiTags(out));
  } catch {
    // Never block synthesis on the expressiveness pass.
    return clean;
  }
}
