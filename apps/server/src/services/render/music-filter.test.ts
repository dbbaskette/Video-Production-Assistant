import { describe, it, expect } from 'vitest';
import { buildMusicFilterComplex } from './music-filter.js';

describe('buildMusicFilterComplex', () => {
  it('full scope loops + ducks music across the whole timeline (no gating)', () => {
    const fc = buildMusicFilterComplex({
      scope: 'full',
      volumeDb: -20,
      totalDurSec: 30,
      introDurSec: 0,
      outroDurSec: 0,
    });
    expect(fc).toContain('aloop=loop=-1');
    expect(fc).toContain('volume=-20dB');
    expect(fc).toContain('amix=inputs=2:duration=first');
    // No timeline muting on the full-timeline path.
    expect(fc).not.toContain('enable=');
  });

  it('bumpers scope mutes the middle (scenes) between intro and outro windows', () => {
    const fc = buildMusicFilterComplex({
      scope: 'bumpers',
      volumeDb: -18,
      totalDurSec: 20,
      introDurSec: 2,
      outroDurSec: 3,
    });
    // Middle to mute is [introDur, totalDur - outroDur] = [2, 17].
    expect(fc).toContain("volume=0:enable='between(t,2.000,17.000)'");
    expect(fc).toContain('volume=-18dB');
    expect(fc).toContain('amix=inputs=2:duration=first');
  });

  it('bumpers scope with only an intro mutes everything after the intro', () => {
    const fc = buildMusicFilterComplex({
      scope: 'bumpers',
      volumeDb: -20,
      totalDurSec: 20,
      introDurSec: 2,
      outroDurSec: 0,
    });
    expect(fc).toContain("volume=0:enable='between(t,2.000,20.000)'");
  });

  it('bumpers scope with no bumpers mutes the entire track', () => {
    const fc = buildMusicFilterComplex({
      scope: 'bumpers',
      volumeDb: -20,
      totalDurSec: 20,
      introDurSec: 0,
      outroDurSec: 0,
    });
    expect(fc).toContain("volume=0:enable='between(t,0.000,20.000)'");
  });

  it('applies composition-defined fixed music fades', () => {
    const fc = buildMusicFilterComplex({
      scope: 'full',
      volumeDb: -12,
      totalDurSec: 10,
      introDurSec: 0,
      outroDurSec: 0,
      fadeInSec: 0.5,
      fadeOutSec: 2,
    });
    expect(fc).toContain('afade=t=in:st=0:d=0.500');
    expect(fc).toContain('afade=t=out:st=8.000:d=2.000');
  });

  it('creates a bounded music-only output when the composed video is silent', () => {
    const fc = buildMusicFilterComplex({ scope: 'full', volumeDb: -18, totalDurSec: 6, introDurSec: 0, outroDurSec: 0, hasBaseAudio: false });
    expect(fc).not.toContain('[0:a]');
    expect(fc).toContain('atrim=duration=6.000[aout]');
  });
});
