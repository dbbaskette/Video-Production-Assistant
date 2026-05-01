/**
 * Google Gemini TTS provider.
 *
 * Uses the Gemini generative AI API with audio output modality.
 * Requires GEMINI_API_KEY in the environment.
 *
 * Voice catalog sourced from:
 * https://ai.google.dev/gemini-api/docs/speech-generation
 */

import type { TtsProvider, TtsResult, TtsGenerateOpts } from '../provider.js';

/** Strip emotive tags like [warm], [confident] from text. */
function stripEmotiveTags(text: string): string {
  return text.replace(/\[[\w-]+\]\s*/g, '').trim();
}

/** Wrap raw PCM samples (16-bit LE, mono) in a RIFF/WAVE container. */
function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcm.length;
  const headerSize = 44;

  const wav = Buffer.alloc(headerSize + dataSize);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(numChannels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(byteRate, 28);
  wav.writeUInt16LE(blockAlign, 32);
  wav.writeUInt16LE(bitsPerSample, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataSize, 40);
  pcm.copy(wav, headerSize);

  return wav;
}

const SAMPLE_RATE = 24000;
const MODEL = 'gemini-2.5-flash-preview-tts';

/**
 * Full catalog of Gemini prebuilt voices.
 * Sourced from Google's docs and the tanzu-video-pipeline voice catalog.
 */
const GEMINI_VOICES = [
  { id: 'Kore',      name: 'Kore',      description: 'Crisp professional female — reliable default' },
  { id: 'Charon',    name: 'Charon',     description: 'Deep authoritative male — trailer / announcer' },
  { id: 'Puck',      name: 'Puck',       description: 'Youthful, playful male — casual / podcast feel' },
  { id: 'Aoede',     name: 'Aoede',      description: 'Warm, even-paced female — product narration' },
  { id: 'Achird',    name: 'Achird',     description: 'Friendly warm male — conversational explainer' },
  { id: 'Fenrir',    name: 'Fenrir',     description: 'Gruff male storyteller — dramatic case studies' },
  { id: 'Leda',      name: 'Leda',       description: 'Airy, upbeat female — marketing & onboarding' },
  { id: 'Orus',      name: 'Orus',       description: 'Bright, energetic male — tutorials' },
  { id: 'Achernar',  name: 'Achernar',   description: 'Crisp, soft-spoken female — intimate narration' },
  { id: 'Algieba',   name: 'Algieba',    description: 'Smooth deep male — authoritative narration' },
  { id: 'Autonoe',   name: 'Autonoe',    description: 'Bright, upbeat female — marketing intros' },
  { id: 'Despina',   name: 'Despina',    description: 'Clear, neutral female — reliable narrator' },
  { id: 'Erinome',   name: 'Erinome',    description: 'Clear, forward female — presentations' },
  { id: 'Gacrux',    name: 'Gacrux',     description: 'Mature, warm female — good for dialog' },
  { id: 'Iapetus',   name: 'Iapetus',    description: 'Clear, measured male — technical narration' },
  { id: 'Schedar',   name: 'Schedar',    description: 'Crisp, steady male — presentation narration' },
  { id: 'Umbriel',   name: 'Umbriel',    description: 'Calm, contemplative male — thoughtful tone' },
  { id: 'Zephyr',    name: 'Zephyr',     description: 'Light, airy female — great for intros' },
] as const;

export function createGeminiTtsProvider(apiKey: string): TtsProvider {
  return {
    id: 'gemini',
    displayName: 'Google Gemini TTS',
    supportedEmotives: new Set([
      'warm', 'confident', 'thoughtful', 'calm', 'excited',
      'curious', 'serious', 'friendly', 'professional', 'enthusiastic',
    ]),
    voices: GEMINI_VOICES.map((v) => ({
      id: v.id,
      name: v.name,
      description: v.description,
    })),

    async generate(script: string, opts: TtsGenerateOpts): Promise<TtsResult> {
      const { GoogleGenAI } = await import('@google/genai');

      const ai = new GoogleGenAI({ apiKey });
      const voice = opts.voice ?? 'Kore';
      const cleanText = stripEmotiveTags(script);

      const response = await ai.models.generateContent({
        model: MODEL,
        contents: [{ parts: [{ text: cleanText }] }],
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: voice },
            },
          },
        },
      });

      const inlineData = response.candidates?.[0]?.content?.parts?.[0]?.inlineData;
      if (!inlineData?.data) {
        throw new Error('Gemini TTS returned no audio data');
      }

      const pcm = Buffer.from(inlineData.data, 'base64');
      const audio = pcmToWav(pcm, SAMPLE_RATE);

      // Approximate duration from PCM length: 16-bit mono at 24kHz
      const durationSec = pcm.length / (SAMPLE_RATE * 2);

      // Generate word-level timings by distributing evenly
      const words = cleanText.split(/\s+/).filter((w) => w.length > 0);
      const timings = words.map((word, i) => ({
        word,
        t: Math.round((i * durationSec / words.length) * 100) / 100,
      }));

      return { audio, timings, durationSec: Math.round(durationSec * 100) / 100 };
    },
  };
}
