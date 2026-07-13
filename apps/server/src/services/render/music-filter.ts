/**
 * Build the ffmpeg `-filter_complex` string that mixes background music
 * under an already-assembled video's audio.
 *
 * Kept as a pure function (no ffmpeg, no fs) so the filter graph — the
 * load-bearing, easy-to-get-subtly-wrong part — is unit-testable.
 *
 * Inputs to the ffmpeg call:
 *   [0:a] = the assembled video's own audio (narration / original)
 *   [1:a] = the background music track
 */

export type MusicScope = 'full' | 'bumpers';

export interface MusicFilterOpts {
  /** 'full' = music over the whole timeline; 'bumpers' = only over the
   *  intro/outro bumper windows, silent over the scenes. */
  scope: MusicScope;
  /** Music gain in dB (negative ducks it under narration). */
  volumeDb: number;
  /** Total assembled duration in seconds (used for the tail fade + outro window). */
  totalDurSec: number;
  /** Intro bumper duration; 0 when there's no intro bumper. */
  introDurSec: number;
  /** Outro bumper duration; 0 when there's no outro bumper. */
  outroDurSec: number;
}

export function buildMusicFilterComplex(opts: MusicFilterOpts): string {
  // 1.5s tail fade keeps the music from cutting off abruptly.
  const fadeOutStart = Math.max(0, opts.totalDurSec - 1.5);

  const musicChain = [`aloop=loop=-1:size=2147483647`, `volume=${opts.volumeDb}dB`];

  if (opts.scope === 'bumpers') {
    // Mute music everywhere EXCEPT the intro window [0, introDur] and the
    // outro window [totalDur - outroDur, totalDur]. The `volume` filter with
    // a timeline `enable` is bypassed (passthrough) outside the enabled
    // region, so muting the middle leaves music playing only over the
    // bumpers. With no bumpers (both 0) this mutes the whole track — which
    // is the intended "bumpers only, but there are none" outcome; the UI
    // prevents that combination.
    const outroStart = Math.max(0, opts.totalDurSec - opts.outroDurSec);
    musicChain.push(
      `volume=0:enable='between(t,${opts.introDurSec.toFixed(3)},${outroStart.toFixed(3)})'`,
    );
  }

  musicChain.push(`afade=t=out:st=${fadeOutStart.toFixed(3)}:d=1.5`);

  return [
    `[1:a]${musicChain.join(',')}[music]`,
    `[0:a][music]amix=inputs=2:duration=first:dropout_transition=2[aout]`,
  ].join(';');
}
