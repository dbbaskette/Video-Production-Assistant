import { describe, expect, it } from 'vitest';
import type { Scene } from '@vpa/shared';
import { RenderError, resolveRenderSceneDuration } from './scene-duration.js';

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

describe('resolveRenderSceneDuration', () => {
  it('uses narration as the flexible duration of a presentation slide', () => {
    expect(resolveRenderSceneDuration(slideScene, 12.4)).toEqual({
      targetSec: 12.4,
      flexible: true,
      source: 'narration',
    });
  });

  it('uses the slide hold when narration is unavailable', () => {
    expect(resolveRenderSceneDuration(slideScene)).toEqual({
      targetSec: 5,
      flexible: true,
      source: 'slide-hold',
    });
  });

  it('keeps a normal recording fixed to its meaningful duration', () => {
    expect(resolveRenderSceneDuration(videoScene)).toEqual({
      targetSec: 30,
      flexible: false,
      source: 'recording',
    });
  });

  it('ignores invalid narration durations and returns a bounded render error for missing recording duration', () => {
    for (const duration of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(resolveRenderSceneDuration(slideScene, duration).source).toBe('slide-hold');
    }
    expect(() => resolveRenderSceneDuration({ ...videoScene, recording: { source: 'recordings/demo.mp4' } }))
      .toThrowError(RenderError);
    expect(() => resolveRenderSceneDuration({ ...videoScene, recording: { source: 'recordings/demo.mp4' } }))
      .toThrowError(/^Scene recording duration is unavailable$/);
  });

  it('never infers render duration from stored chunk timing without a valid prepared-audio probe', () => {
    const sceneWithStoredChunks: Scene = {
      ...slideScene,
      narration: {
        script: 'Stored narration',
        chunks: [{
          index: 0,
          text: 'Stored narration',
          audio: 'narration/chunk.mp3',
          durationSec: 8.25,
        }],
      },
    };

    for (const duration of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(resolveRenderSceneDuration(sceneWithStoredChunks, duration)).toEqual({
        targetSec: 5,
        flexible: true,
        source: 'slide-hold',
      });
    }
    expect(resolveRenderSceneDuration(sceneWithStoredChunks, 8.25)).toEqual({
      targetSec: 8.25,
      flexible: true,
      source: 'narration',
    });
  });

  it('does not infer presentation semantics from a presentation-looking filename', () => {
    expect(resolveRenderSceneDuration({
      ...videoScene,
      type: 'slide',
      recording: { source: 'presentations/fake/clips/page-0001.mp4', duration_sec: 30 },
    }, 12.4)).toEqual({ targetSec: 30, flexible: false, source: 'recording' });
  });
});
