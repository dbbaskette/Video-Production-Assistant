import { describe, expect, it } from 'vitest';
import {
  BrowserCaptureSessionSchema,
  SceneCompositionSchema,
  compositionDurationMs,
  normalizeCompositionTimeline,
  sourceAnchorsForClip,
} from './index.js';

const a = `asset_${'a'.repeat(64)}`;
const b = `asset_${'b'.repeat(64)}`;

describe('composition contracts', () => {
  it('normalizes an ordered repeated-source sequence with independent instance IDs', () => {
    const clips = normalizeCompositionTimeline([
      { id: 'clip_first-0001', source_asset_id: a, source_role: 'screen', source_in_ms: 1_000, source_out_ms: 4_000, timeline_start_ms: 99, linked_tracks: [{ asset_id: b, role: 'microphone', source_offset_ms: 20 }] },
      { id: 'clip_second-0002', source_asset_id: a, source_role: 'screen', source_in_ms: 5_000, source_out_ms: 7_500, timeline_start_ms: 99, linked_tracks: [{ asset_id: b, role: 'microphone', source_offset_ms: 20 }] },
    ]);
    const composition = SceneCompositionSchema.parse({ version: 1, clips, audio_mix: {} });
    expect(composition.clips.map((clip) => clip.timeline_start_ms)).toEqual([0, 3_000]);
    expect(compositionDurationMs(composition)).toBe(5_500);
  });

  it('rejects non-contiguous sequence timing and invalid bounds', () => {
    expect(() => SceneCompositionSchema.parse({
      version: 1,
      clips: [{ id: 'clip_invalid-0001', source_asset_id: a, source_role: 'screen', source_in_ms: 3_000, source_out_ms: 2_000, timeline_start_ms: 1, linked_tracks: [] }],
      audio_mix: {},
    })).toThrow();
  });

  it('requires a real screen track and unique capture roles', () => {
    expect(() => BrowserCaptureSessionSchema.parse({
      version: 1,
      id: '72f0c3a4-e52c-4f49-bf91-cf2bd0f2b94c',
      project_id: '62f0c3a4-e52c-4f49-bf91-cf2bd0f2b94c',
      scene_id: 'scene-01',
      status: 'recording',
      created_at: '2026-09-25T12:00:00.000Z',
      updated_at: '2026-09-25T12:00:00.000Z',
      common_clock_origin_ms: 10,
      tracks: [{ id: 'track_mic-0001', role: 'microphone', kind: 'audio', mime_type: 'audio/webm', timing_origin_ms: 0 }],
    })).toThrow(/screen track/);
  });

  it('keeps source-anchored captions/effects attached across repeated source instances', () => {
    const clips = normalizeCompositionTimeline([
      { id: 'clip_repeat-0001', source_asset_id: a, source_role: 'screen', source_in_ms: 0, source_out_ms: 2_000, timeline_start_ms: 0, linked_tracks: [] },
      { id: 'clip_repeat-0002', source_asset_id: a, source_role: 'screen', source_in_ms: 0, source_out_ms: 2_000, timeline_start_ms: 0, linked_tracks: [] },
    ]);
    const composition = SceneCompositionSchema.parse({ version: 1, clips, audio_mix: {}, anchors: [{ id: 'anchor_caption-001', kind: 'caption', source_asset_id: a, source_time_ms: 500 }] });
    expect(sourceAnchorsForClip(composition, composition.clips[0]!)).toHaveLength(1);
    expect(sourceAnchorsForClip(composition, composition.clips[1]!)).toHaveLength(1);
  });
});
