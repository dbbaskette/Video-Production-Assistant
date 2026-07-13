/**
 * Parse inline `[pause <duration>]` tokens in narration into timed inter-chunk
 * gaps. A pause becomes SILENCE inserted between chunks at concat time — it is
 * never sent to the TTS engine.
 *
 * Rules (see the script-pauses design doc):
 *   - `[pause 1.5s]` / `[pause 2]` / `[pause 0.8 s]` → a chunk boundary; the
 *     numeric value (clamped 0.1–10s) is the trailing gap of the segment before
 *     it. The token is stripped from the text.
 *   - `[pause abc]` (non-numeric) → stripped, no gap, no boundary.
 *   - `[pause]` (bare) → left untouched; it belongs to the xAI expressive path.
 *   - A leading pause (no speech before it) is dropped; a trailing pause stays
 *     as the last segment's trailing gap; consecutive pauses fold into one gap.
 */

export interface PauseSegment {
  text: string;
  gapSec: number;
}

const TOKEN = /\[pause\b([^\]]*)\]/gi;
const MIN_GAP = 0.1;
const MAX_GAP = 10;

function clampGap(n: number): number {
  return Math.min(MAX_GAP, Math.max(MIN_GAP, n));
}

/** Parse a numeric pause duration from a token's inner text, else null. */
function parseDuration(inner: string): number | null {
  const m = inner.trim().match(/^(\d+(?:\.\d+)?)\s*s?$/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** Collapse runs of spaces/tabs (but not newlines) and trim. */
function normalize(text: string): string {
  return text.replace(/[^\S\n]+/g, ' ').trim();
}

export function parsePauses(input: string): PauseSegment[] {
  const segments: PauseSegment[] = [];
  let text = '';
  let lastEnd = 0;

  const closeSegment = (gap: number) => {
    const t = normalize(text);
    if (t.length > 0) {
      segments.push({ text: t, gapSec: gap });
    } else if (segments.length > 0) {
      // No new speech since the last boundary → fold this gap onto the
      // previous segment (consecutive pauses combine).
      const prev = segments[segments.length - 1]!;
      prev.gapSec = clampGap(prev.gapSec + gap);
    }
    // else: a leading gap with no prior speech → dropped.
    text = '';
  };

  TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  let matched = false;
  while ((m = TOKEN.exec(input)) !== null) {
    matched = true;
    text += input.slice(lastEnd, m.index);
    lastEnd = m.index + m[0].length;

    const inner = (m[1] ?? '').trim();
    if (inner === '') {
      // Bare [pause] — keep it in the text for the xAI expressive path.
      text += m[0];
      continue;
    }
    const dur = parseDuration(inner);
    if (dur === null) {
      // Malformed (e.g. [pause abc]) — strip it, no gap, no boundary.
      continue;
    }
    closeSegment(clampGap(dur));
  }

  text += input.slice(lastEnd);
  const tail = normalize(text);
  if (tail.length > 0) {
    segments.push({ text: tail, gapSec: 0 });
  }

  if (segments.length > 0) return segments;
  // No speech survived. If tokens were present the input was all-pause (empty
  // segment, callers filter it); otherwise return the (token-free) input.
  return matched ? [{ text: '', gapSec: 0 }] : [{ text: normalize(input), gapSec: 0 }];
}
