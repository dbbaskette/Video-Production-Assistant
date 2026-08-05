import { describe, expect, it } from 'vitest';
import type { Scene } from '@vpa/shared';
import { RenderError, resolveSceneDuration } from './scene-duration.js';

const slideScene: Scene = {
  id: 'scene-slide-2',
  name: 'Architecture',
  description: 'Three services and their data flow.',
  type: 'slide',
  recording: {
    source: 'presentations/1e570aa5-20ce-4779-ad9a-d4db3ae73991/clips/page-0002.mp4',
    source_kind: 'presentation',
    duration_sec: 1,
  },
  presentation_source: {
    presentation_id: '1e570aa5-20ce-4779-ad9a-d4db3ae73991',
    page_number: 2,
    page_count: 3,
    image: 'presentations/1e570aa5-20ce-4779-ad9a-d4db3ae73991/pages/page-0002.png',
    hold_duration_sec: 5,
  },
};

const videoScene: Scene = {
  id: 'scene-video',
  name: 'Recording',
  description: 'A normal recording.',
  type: 'desktop',
  recording: { source: 'recordings/demo.mp4', duration_sec: 30 },
};

describe('resolveSceneDuration', () => {
  it('uses narration as the flexible duration of a presentation slide', () => {
    expect(resolveSceneDuration(slideScene, 12.4)).toEqual({
      targetSec: 12.4,
      flexible: true,
      source: 'narration',
    });
  });

  it('uses the slide hold when narration is unavailable', () => {
    expect(resolveSceneDuration(slideScene)).toEqual({
      targetSec: 5,
      flexible: true,
      source: 'slide-hold',
    });
  });

  it('keeps a normal recording fixed to its meaningful duration', () => {
    expect(resolveSceneDuration(videoScene)).toEqual({
      targetSec: 30,
      flexible: false,
      source: 'recording',
    });
  });

  it('ignores invalid narration durations and returns a bounded render error for missing recording duration', () => {
    expect(resolveSceneDuration(slideScene, Number.POSITIVE_INFINITY).source).toBe('slide-hold');
    expect(() => resolveSceneDuration({ ...videoScene, recording: { source: 'recordings/demo.mp4' } }))
      .toThrowError(RenderError);
    expect(() => resolveSceneDuration({ ...videoScene, recording: { source: 'recordings/demo.mp4' } }))
      .toThrowError(/^Scene recording duration is unavailable$/);
  });
});
