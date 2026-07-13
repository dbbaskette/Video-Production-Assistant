/**
 * xAI (Grok) TTS provider.
 *
 * Endpoint: POST https://api.x.ai/v1/tts
 * Requires XAI_API_KEY in the environment.
 *
 * Five named voices (case-sensitive): Eve, Ara, Leo, Rex, Sal.
 * No model parameter — single model surfaced through the voices.
 *
 * See: https://docs.x.ai/developers/model-capabilities/audio/
 */

import type { TtsProvider, TtsResult, TtsGenerateOpts } from '../provider.js';
import { stripAppEmotives, stripXaiTags } from '../expressiveness.js';

const XAI_VOICES = [
  { id: 'Sal', name: 'Sal', description: 'Smooth & balanced — reliable default' },
  { id: 'Eve', name: 'Eve', description: 'Energetic & upbeat — marketing and onboarding' },
  { id: 'Ara', name: 'Ara', description: 'Warm & friendly — conversational narration' },
  { id: 'Leo', name: 'Leo', description: 'Authoritative & strong — technical walkthroughs' },
  { id: 'Rex', name: 'Rex', description: 'Confident & clear — trailers and explainers' },
] as const;

export function createXaiTtsProvider(apiKey: string): TtsProvider {
  return {
    id: 'xai',
    displayName: 'xAI (Grok) TTS',
    supportedEmotives: new Set([
      'warm', 'confident', 'calm', 'excited', 'serious', 'friendly',
    ]),
    voices: XAI_VOICES.map((v) => ({
      id: v.id,
      name: v.name,
      description: v.description,
    })),

    async generate(script: string, opts: TtsGenerateOpts): Promise<TtsResult> {
      // IMPORTANT: xAI's /v1/tts vocalizes inline/wrapping tags as LITERAL text
      // (verified empirically — `<emphasis>`, `[pause]`, `<slow>` etc. are
      // spoken, not honored, despite the docs). So we send FULLY tag-stripped
      // text: app emotives (`[warm]`) AND all xAI markup are removed. `spokenText`
      // also drives the word count / timings.
      const spokenText = stripXaiTags(stripAppEmotives(script));
      const voice_id = opts.voice ?? 'Sal';

      const body = {
        text: spokenText,
        voice_id,
        language: 'en',
        output_format: {
          codec: 'mp3',
          sample_rate: 44100,
          bit_rate: 128000,
        },
      };

      const resp = await fetch('https://api.x.ai/v1/tts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        if (resp.status === 401) {
          throw new Error(
            `xAI TTS authentication failed (401). Check that XAI_API_KEY is set correctly.`,
          );
        }
        if (resp.status === 404) {
          throw new Error(
            `xAI TTS endpoint not found (404). Voice '${voice_id}' may not exist — valid names are Eve, Ara, Leo, Rex, Sal (case-sensitive).`,
          );
        }
        throw new Error(`xAI TTS failed (${resp.status}): ${errText.slice(0, 300)}`);
      }

      const audio = Buffer.from(await resp.arrayBuffer());

      // Approximate duration: ~150 words/min adjusted by speed
      const speed = opts.speed ?? 1.0;
      const wordCount = spokenText.split(/\s+/).filter((w) => w.length > 0).length;
      const durationSec = Math.max(1, (wordCount / 150) * 60) / speed;

      // Generate word-level timings by distributing evenly
      const words = spokenText.split(/\s+/).filter((w) => w.length > 0);
      const timings = words.map((word, i) => ({
        word,
        t: Math.round((i * durationSec / words.length) * 100) / 100,
      }));

      return {
        audio,
        timings,
        durationSec: Math.round(durationSec * 100) / 100,
      };
    },
  };
}
