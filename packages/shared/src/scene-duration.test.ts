import { describe, expect, it } from 'vitest';
import type { Scene } from './storyboard.js';
import {
  preparedNarrationDurationSec,
  resolvePlannedSceneDuration,
} from './scene-duration.js';

const presentationScene: Scene = {
  id: 'scene-slide',
  name: 'Slide',
  description: 'A presentation slide.',
  type: 'slide',
  recording: {
    source: 'presentations/1e570aa5-20ce-4779-ad9a-d4db3ae73991/clips/page-0001.mp4',
    source_kind: 'presentation',
    duration_sec: 1,
  },
  presentation_source: {
    presentation_id: '1e570aa5-20ce-4779-ad9a-d4db3ae73991',
    page_number: 1,
    page_count: 1,
    image: 'presentations/1e570aa5-20ce-4779-ad9a-d4db3ae73991/pages/page-0001.png',
    hold_duration_sec: 5,
  },
};

describe('effective scene duration', () => {
  it('uses prepared narration timing for a validated presentation scene', () => {
    const scene: Scene = {
      ...presentationScene,
      narration: {
        script: 'Narration',
        chunks: [
          { index: 0, text: 'One', audio: 'narration/one.mp3', durationSec: 3, gapSec: 0.25 },
          { index: 1, text: 'Two', audio: 'narration/two.mp3', durationSec: 5 },
        ],
      },
    };

    expect(preparedNarrationDurationSec(scene)).toBe(8.25);
    expect(resolvePlannedSceneDuration(scene)).toEqual({
      targetSec: 8.25,
      flexible: true,
      source: 'narration',
    });
  });

  it('falls back to the hold when no stored narration timing is available', () => {
    expect(resolvePlannedSceneDuration(presentationScene)).toEqual({
      targetSec: 5,
      flexible: true,
      source: 'slide-hold',
    });
  });

  it('does not treat a filename-only slide impostor as a presentation scene', () => {
    const impostor: Scene = {
      id: 'scene-impostor',
      name: 'Impostor',
      description: 'Ordinary video with a presentation-looking filename.',
      type: 'slide',
      recording: {
        source: 'presentations/fake/clips/page-0001.mp4',
        duration_sec: 30,
      },
    };

    expect(resolvePlannedSceneDuration(impostor)).toEqual({
      targetSec: 30,
      flexible: false,
      source: 'recording',
    });
  });
});
