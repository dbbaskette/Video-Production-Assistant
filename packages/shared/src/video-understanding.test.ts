import { describe, expect, it } from 'vitest';
import { VideoUnderstandingBriefSchema } from './video-understanding.js';

const validBrief = {
  schema_version: 1,
  prompt_version: 1,
  scene_id: 'scene-01',
  source: {
    path: 'recordings/scene-01.mp4',
    sha256: 'a'.repeat(64),
    duration_sec: 12.5,
    width: 1920,
    height: 1080,
  },
  model: { entry_id: 'gemini-video', provider: 'gemini', model: 'gemini-2.5-pro' },
  created_at: '2026-08-01T12:00:00.000Z',
  visual_summary: 'A settings page switches from a model list to role assignments.',
  segments: [
    {
      id: 'segment-001',
      start_sec: 0,
      end_sec: 5,
      screen_change: 'The settings page opens.',
      visible_labels: ['Settings'],
      on_screen_terms: ['Model assignments'],
    },
    {
      id: 'segment-002',
      start_sec: 5,
      end_sec: 12.5,
      screen_change: 'The writing role is selected.',
      visible_labels: ['Writing'],
      on_screen_terms: ['Codex'],
    },
  ],
  pacing_cues: [{ segment_id: 'segment-001', cue: 'Hold long enough to orient the viewer.' }],
  narration_cues: [{ segment_id: 'segment-002', cue: 'Explain the selected writing role.' }],
  lower_third_candidates: [{ segment_id: 'segment-002', reason: 'The selected role is clearly visible.' }],
};

describe('VideoUnderstandingBriefSchema', () => {
  it('round trips a valid versioned video brief', () => {
    expect(VideoUnderstandingBriefSchema.parse(validBrief)).toEqual(validBrief);
  });

  it('rejects non-finite and negative segment timestamps', () => {
    expect(() => VideoUnderstandingBriefSchema.parse({
      ...validBrief,
      segments: [{ ...validBrief.segments[0], start_sec: Number.NaN }],
    })).toThrow();
    expect(() => VideoUnderstandingBriefSchema.parse({
      ...validBrief,
      segments: [{ ...validBrief.segments[0], start_sec: -0.1 }],
    })).toThrow();
  });

  it('requires each segment to have a positive duration', () => {
    expect(() => VideoUnderstandingBriefSchema.parse({
      ...validBrief,
      segments: [{ ...validBrief.segments[0], end_sec: 0 }],
    })).toThrow();
  });

  it('rejects segments that are not monotonic or exceed the source duration', () => {
    expect(() => VideoUnderstandingBriefSchema.parse({
      ...validBrief,
      segments: [validBrief.segments[1], validBrief.segments[0]],
    })).toThrow();
    expect(() => VideoUnderstandingBriefSchema.parse({
      ...validBrief,
      segments: [{ ...validBrief.segments[1], end_sec: 13 }],
    })).toThrow();
  });

  it('requires stable unique segment IDs and linked cue references', () => {
    expect(() => VideoUnderstandingBriefSchema.parse({
      ...validBrief,
      segments: [validBrief.segments[0], { ...validBrief.segments[1], id: 'segment-001' }],
    })).toThrow();
    expect(() => VideoUnderstandingBriefSchema.parse({
      ...validBrief,
      narration_cues: [{ segment_id: 'missing-segment', cue: 'This reference is invalid.' }],
    })).toThrow();
  });

  it('bounds segment labels and on-screen terms', () => {
    expect(() => VideoUnderstandingBriefSchema.parse({
      ...validBrief,
      segments: [{ ...validBrief.segments[0], visible_labels: Array(51).fill('label') }],
    })).toThrow();
    expect(() => VideoUnderstandingBriefSchema.parse({
      ...validBrief,
      segments: [{ ...validBrief.segments[0], on_screen_terms: ['x'.repeat(201)] }],
    })).toThrow();
  });
});
