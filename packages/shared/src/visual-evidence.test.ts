import { describe, expect, it } from 'vitest';
import { SceneCompositionSchema, SourceTranscriptSchema, VisualEffectSchema, mapTranscriptToComposition, mappedTranscriptSrt } from './index.js';

const asset = `asset_${'a'.repeat(64)}`;
const transcript = SourceTranscriptSchema.parse({
  version: 1, source_asset_id: asset, source_sha256: 'a'.repeat(64), language: 'en', provider: 'gemini', model: 'gemini-test', settings_hash: 'b'.repeat(64), created_at: '2026-09-25T12:00:00.000Z', coverage: [{ start_ms: 0, end_ms: 10_000 }],
  words: [
    { id: 'word_000001', text: 'hello', start_ms: 1_000, end_ms: 1_400, confidence: 0.98, speaker: 'A' },
    { id: 'word_000002', text: 'corrected', original_text: 'world', start_ms: 5_000, end_ms: 5_500, confidence: 0.5, speaker: 'B' },
  ], passages: [{ id: 'passage_000001', start_ms: 1_000, end_ms: 5_500, text: 'hello corrected', word_ids: ['word_000001', 'word_000002'] }],
});

describe('visual and evidence contracts', () => {
  it('rejects out-of-frame geometry and arbitrary effect payloads', () => {
    const base = { type: 'redaction', id: 'effect_redact-001', clip_instance_id: 'clip_example-001', source_asset_id: asset, source_in_ms: 0, source_out_ms: 1_000, rect: { x: 0.9, y: 0, width: 0.2, height: 0.2 }, opacity: 1 };
    expect(() => VisualEffectSchema.parse(base)).toThrow(/inside/);
    expect(() => VisualEffectSchema.parse({ ...base, rect: { x: 0, y: 0, width: 0.2, height: 0.2 }, script: 'drawtext=evil' })).toThrow();
  });

  it('maps corrected source words through trims, reorder and repeated clip instances', () => {
    const composition = SceneCompositionSchema.parse({ version: 1, audio_mix: {}, clips: [
      { id: 'clip_late-0001', source_asset_id: asset, source_role: 'screen', source_in_ms: 4_000, source_out_ms: 6_000, timeline_start_ms: 0, linked_tracks: [] },
      { id: 'clip_early-002', source_asset_id: asset, source_role: 'screen', source_in_ms: 500, source_out_ms: 2_000, timeline_start_ms: 2_000, linked_tracks: [] },
      { id: 'clip_repeat-003', source_asset_id: asset, source_role: 'screen', source_in_ms: 500, source_out_ms: 2_000, timeline_start_ms: 3_500, linked_tracks: [] },
    ] });
    const mapped = mapTranscriptToComposition(transcript, composition);
    expect(mapped.map((word) => [word.text, word.timeline_start_ms, word.clip_instance_id])).toEqual([
      ['corrected', 1_000, 'clip_late-0001'], ['hello', 2_500, 'clip_early-002'], ['hello', 4_000, 'clip_repeat-003'],
    ]);
    expect(mappedTranscriptSrt(mapped, 1)).toContain('corrected');
    expect(mappedTranscriptSrt(mapped, 1)).toContain('00:00:04,000');
  });
});
