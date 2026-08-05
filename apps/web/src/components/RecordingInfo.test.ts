import { describe, expect, it } from 'vitest';
import { resolveRecordingDurationLabel } from './RecordingInfo.js';
import type { Scene } from '@vpa/shared';

const presentation: Scene = {
  id: 'slide',
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

describe('resolveRecordingDurationLabel', () => {
  it('uses narration rather than the physical clip duration for narrated slides', () => {
    expect(resolveRecordingDurationLabel({
      ...presentation,
      narration: { script: 'Narration', audio: 'narration/slide.mp3' },
    }))
      .toBe('Narration sets final length');
  });

  it('uses the configured hold rather than the physical clip duration for silent slides', () => {
    expect(resolveRecordingDurationLabel(presentation))
      .toBe('5s hold without narration');
  });

  it('preserves ordinary recording duration formatting', () => {
    expect(resolveRecordingDurationLabel({
      id: 'video',
      name: 'Video',
      description: 'A recording.',
      type: 'desktop',
      recording: { source: 'recordings/video.mp4', duration_sec: 65 },
    }))
      .toBe('1m 5s');
  });
});
