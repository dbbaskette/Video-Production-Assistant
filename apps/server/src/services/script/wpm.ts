/**
 * Compute the project's actual TTS words-per-minute rate from chunks that
 * already have both text and a measured duration.
 *
 * Why empirical and not a hard-coded 150: different TTS engines / voices /
 * speeds produce different rates. xAI's default voices run ~154 wpm; a
 * slower neural voice can be 120; the narration-writer prompt has always
 * targeted 150 as a rough guess. Once the project has generated any
 * narration, we have the real number — use it, otherwise fall back to 150.
 *
 * Returns null when nothing has been measured yet; callers should treat
 * that as "use the default 150 wpm fallback".
 */
import type { Storyboard } from '@vpa/shared';

export const DEFAULT_WPM = 150;

export function computeProjectWpm(sb: Storyboard): {
  wpm: number;
  isMeasured: boolean;
  sampleChunks: number;
} {
  let totalWords = 0;
  let totalSeconds = 0;
  let sampleChunks = 0;

  for (const scene of sb.scenes) {
    const chunks = scene.narration?.chunks ?? [];
    for (const c of chunks) {
      const dur = c.durationSec;
      const text = c.text ?? '';
      if (!dur || dur <= 0) continue;
      const words = text.split(/\s+/).filter(Boolean).length;
      if (words === 0) continue;
      totalWords += words;
      totalSeconds += dur;
      sampleChunks += 1;
    }
  }

  if (sampleChunks === 0 || totalSeconds === 0) {
    return { wpm: DEFAULT_WPM, isMeasured: false, sampleChunks: 0 };
  }
  return {
    wpm: Math.round((totalWords / totalSeconds) * 60),
    isMeasured: true,
    sampleChunks,
  };
}
