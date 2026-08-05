import { describe, expect, it } from 'vitest';
import type { Scene } from '@vpa/shared';
import {
  lowerThirdTimelineDurationSec,
  recordingInfoDurationLabel,
  recordingsDurationLabel,
  scriptDurationGuidance,
} from './scene-duration.js';

const slide: Scene = {
  id: 'scene-slide',
  name: 'Slide',
  description: 'A slide.',
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

describe('scene duration UI semantics', () => {
  it('uses the hold and suppresses recording-fit actions for a silent slide', () => {
    expect(recordingsDurationLabel(slide)).toBe('5s hold without narration');
    expect(recordingInfoDurationLabel(slide)).toBe('5s hold without narration');
    expect(lowerThirdTimelineDurationSec(slide)).toBe(5);
    expect(scriptDurationGuidance(slide)).toEqual({ mode: 'flexible', label: 'Narration sets final length' });
  });

  it('uses stored prepared narration duration for the lower-third timeline', () => {
    const narrated: Scene = {
      ...slide,
      narration: {
        script: 'Narration',
        chunks: [
          { index: 0, text: 'Narration', audio: 'narration/one.mp3', durationSec: 8, gapSec: 0.25 },
        ],
      },
    };

    expect(recordingsDurationLabel(narrated)).toBe('Narration sets final length');
    expect(recordingInfoDurationLabel(narrated)).toBe('Narration sets final length');
    expect(lowerThirdTimelineDurationSec(narrated)).toBe(8.25);
    expect(scriptDurationGuidance(narrated).mode).toBe('flexible');
  });

  it('preserves fixed duration display and fit behavior for an ordinary recording', () => {
    const recording: Scene = {
      id: 'scene-video',
      name: 'Video',
      description: 'A recording.',
      type: 'desktop',
      recording: { source: 'recordings/video.mp4', duration_sec: 65 },
    };

    expect(recordingsDurationLabel(recording)).toBe('1:05');
    expect(recordingInfoDurationLabel(recording)).toBe('1m 5s');
    expect(lowerThirdTimelineDurationSec(recording)).toBe(65);
    expect(scriptDurationGuidance(recording)).toEqual({ mode: 'fixed', durationSec: 65 });
  });
});
