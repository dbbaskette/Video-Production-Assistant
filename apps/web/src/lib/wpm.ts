/**
 * Client-side mirror of the server's `computeProjectWpm`. Reads the same
 * fields off the storyboard response so the live word-count indicator on
 * the Script editor sees the same rate the server uses for Quality Review
 * verdicts and the Tighten action.
 *
 * Returns null when no chunks have a measured duration yet — caller
 * should treat that as "use the 150 wpm fallback".
 */
import type { Storyboard } from '@vpa/shared';

export const DEFAULT_WPM = 150;

export function computeProjectWpm(sb: Storyboard | undefined | null): {
  wpm: number;
  isMeasured: boolean;
  sampleChunks: number;
} {
  if (!sb) return { wpm: DEFAULT_WPM, isMeasured: false, sampleChunks: 0 };
  let words = 0;
  let secs = 0;
  let n = 0;
  for (const scene of sb.scenes) {
    for (const c of scene.narration?.chunks ?? []) {
      const d = c.durationSec;
      const text = c.text ?? '';
      if (!d || d <= 0) continue;
      const w = text.split(/\s+/).filter(Boolean).length;
      if (w === 0) continue;
      words += w;
      secs += d;
      n += 1;
    }
  }
  if (n === 0 || secs === 0) return { wpm: DEFAULT_WPM, isMeasured: false, sampleChunks: 0 };
  return { wpm: Math.round((words / secs) * 60), isMeasured: true, sampleChunks: n };
}

/**
 * Verdict on whether a script fits a given recording duration at the
 * project's measured rate. Same thresholds the server uses (TOO LONG when
 * ratio > 1.15, unusually short when ratio < 0.5). Returns the colour
 * tag callers can map to design tokens.
 */
export type FitVerdict = 'under' | 'within' | 'short' | 'over';
export function classifyFit(words: number, durationSec: number, wpm: number): {
  verdict: FitVerdict;
  targetWords: number;
  estimatedSec: number;
  ratio: number;
} {
  const targetWords = Math.max(1, Math.round((durationSec / 60) * wpm));
  const estimatedSec = (words / wpm) * 60;
  const ratio = words / targetWords;
  let verdict: FitVerdict;
  if (ratio > 1.15) verdict = 'over';
  else if (ratio < 0.5) verdict = 'short';
  else if (ratio >= 0.5 && ratio <= 1.0) verdict = 'under';
  else verdict = 'within';
  return { verdict, targetWords, estimatedSec, ratio };
}
