import { describe, it, expect } from 'vitest';
import { SceneSchema } from './storyboard.js';

const presentationSource = {
  presentation_id: '1e570aa5-20ce-4779-ad9a-d4db3ae73991',
  page_number: 2,
  page_count: 3,
  image: 'presentations/1e570aa5-20ce-4779-ad9a-d4db3ae73991/pages/page-0002.png',
  hold_duration_sec: 5,
};

describe('SceneSchema shot_plan additions', () => {
  it('parses an imported presentation scene only when recording provenance is complete', () => {
    const scene = {
      id: 'scene-slide-2',
      name: 'Architecture',
      description: 'Three services and their data flow.',
      type: 'slide',
      recording: {
        source: 'presentations/1e570aa5-20ce-4779-ad9a-d4db3ae73991/clips/page-0002.mp4',
        source_kind: 'presentation',
        duration_sec: 1,
      },
      presentation_source: presentationSource,
    };

    expect(SceneSchema.parse(scene).presentation_source).toEqual(presentationSource);
    expect(SceneSchema.safeParse({ ...scene, presentation_source: undefined }).success).toBe(false);
    expect(SceneSchema.safeParse({ ...scene, recording: undefined }).success).toBe(false);
  });

  it('parses a scene without shot_plan (backwards compatible)', () => {
    const result = SceneSchema.safeParse({
      id: 's1',
      name: 'Intro',
      description: 'Opening shot',
      type: 'desktop',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.shot_plan).toBeUndefined();
      expect(result.data.shot_plan_chat).toBeUndefined();
    }
  });

  it('parses a scene with a valid shot_plan array', () => {
    const result = SceneSchema.safeParse({
      id: 's1',
      name: 'Intro',
      description: 'Opening shot',
      type: 'desktop',
      shot_plan: [
        { index: 1, action: 'Open Terminal' },
        { index: 2, action: 'Type `npm run dev`', note: 'Wait for "ready"' },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.shot_plan).toHaveLength(2);
      expect(result.data.shot_plan?.[1]?.note).toBe('Wait for "ready"');
    }
  });

  it('rejects shot_plan steps with empty action', () => {
    const result = SceneSchema.safeParse({
      id: 's1',
      name: 'Intro',
      description: 'd',
      type: 'desktop',
      shot_plan: [{ index: 0, action: '' }],
    });
    expect(result.success).toBe(false);
  });

  it('parses a scene with shot_plan_chat transcript', () => {
    const result = SceneSchema.safeParse({
      id: 's1',
      name: 'Intro',
      description: 'd',
      type: 'desktop',
      shot_plan_chat: [
        { role: 'user', content: 'Plan the recording', at: '2026-05-19T12:00:00.000Z' },
        { role: 'assistant', content: 'Step 1...', at: '2026-05-19T12:00:01.000Z' },
      ],
    });
    expect(result.success).toBe(true);
  });
});
