import type { TtsProvider, TtsResult, TtsGenerateOpts } from '../provider.js';

/** Strip emotive tags like [warm], [confident] from text. */
function stripEmotiveTags(text: string): string {
  return text.replace(/\[[\w-]+\]\s*/g, '').trim();
}

/** Generate a minimal valid MP3 file (silent MPEG frame). */
function silentMp3(durationSec: number): Buffer {
  // Minimal valid MPEG Audio Layer 3 frame header + padding.
  // This won't actually play audio but is a structurally valid MP3.
  // Real providers return real audio; this is for testing the pipeline.
  const frameHeader = Buffer.from([
    0xff, 0xfb, 0x90, 0x00, // MPEG1, Layer 3, 128kbps, 44100Hz, stereo
  ]);
  // Repeat enough frames to approximate the duration
  // (128kbps @ 1152 samples/frame @ 44100Hz ≈ 26ms per frame)
  const framesNeeded = Math.max(1, Math.ceil(durationSec / 0.026));
  const frameSize = 417; // bytes per frame at 128kbps/44100Hz
  const frame = Buffer.alloc(frameSize);
  frameHeader.copy(frame);

  const buffers: Buffer[] = [];
  for (let i = 0; i < Math.min(framesNeeded, 100); i++) {
    buffers.push(Buffer.from(frame));
  }
  return Buffer.concat(buffers);
}

/** Generate fake word-level timings by distributing words evenly across a duration. */
function generateTimings(
  cleanText: string,
  durationSec: number,
): Array<{ word: string; t: number }> {
  const words = cleanText.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return [];

  const gap = durationSec / words.length;
  return words.map((word, i) => ({
    word,
    t: Math.round(i * gap * 100) / 100,
  }));
}

export function createFakeTtsProvider(): TtsProvider {
  return {
    id: 'fake',
    displayName: 'Fake TTS (Development)',
    supportedEmotives: new Set([
      'warm',
      'confident',
      'thoughtful',
      'calm',
      'excited',
      'curious',
      'serious',
      'friendly',
    ]),
    voices: [
      { id: 'alice', name: 'Alice', description: 'Warm and friendly narrator' },
      { id: 'bob', name: 'Bob', description: 'Clear and confident presenter' },
      { id: 'carol', name: 'Carol', description: 'Thoughtful and measured tone' },
    ],
    async generate(script: string, opts: TtsGenerateOpts): Promise<TtsResult> {
      const cleanText = stripEmotiveTags(script);
      const speed = opts.speed ?? 1.0;

      // Approximate duration: ~150 words/min adjusted by speed
      const wordCount = cleanText.split(/\s+/).filter((w) => w.length > 0).length;
      const durationSec = Math.max(1, (wordCount / 150) * 60) / speed;

      const audio = silentMp3(durationSec);
      const timings = generateTimings(cleanText, durationSec);

      return { audio, timings, durationSec: Math.round(durationSec * 100) / 100 };
    },
  };
}
