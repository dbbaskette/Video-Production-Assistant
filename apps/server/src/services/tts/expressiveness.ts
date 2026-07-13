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
export async function prepareExpressiveText(
  input: PrepareExpressiveTextInput,
): Promise<string> {
  // xAI's /v1/tts vocalizes inline/wrapping tags as literal text (verified
  // empirically — the docs claim support, the endpoint speaks them). So there
  // is NO working way to control xAI expressiveness per-phrase via tags: we do
  // NOT insert them (doing so made xAI read the markup aloud). xAI
  // expressiveness is therefore voice-selection only; the level is a no-op for
  // delivery, same as fake/qwen. For xAI we still drop app emotive cues so a
  // stray `[warm]` isn't spoken; the provider strips any remaining markup too.
  if (input.engine === 'xai') {
    return stripAppEmotives(input.text);
  }
  // Gemini applies the level via a style directive inside its provider; other
  // engines ignore it. Nothing to materialise in the text here.
  return input.text;
}
