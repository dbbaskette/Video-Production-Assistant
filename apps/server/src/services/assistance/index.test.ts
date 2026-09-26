import { describe, expect, it } from 'vitest';
import type { Storyboard } from '@vpa/shared';
import { buildAssistance } from './index.js';

const assetId = `asset_${'a'.repeat(64)}`;
const storyboard: Storyboard = {
  schema_version: 1,
  project: { id: '11111111-1111-4111-8111-111111111111', name: 'assist', created: '2026-09-25T12:00:00.000Z' },
  scenes: [{
    id: 'scene-01', name: 'Demo', description: 'Demo', type: 'desktop',
    composition: { version: 1, audio_mix: {}, clips: [{ id: 'clip_source-001', source_asset_id: assetId, source_role: 'screen', source_in_ms: 0, source_out_ms: 10_000, timeline_start_ms: 0, linked_tracks: [{ asset_id: `asset_${'c'.repeat(64)}`, role: 'microphone', source_offset_ms: 0 }] }] },
    transcript: {
      version: 1, source_asset_id: assetId, source_sha256: 'a'.repeat(64), language: 'en', provider: 'gemini', model: 'gemini-test', settings_hash: 'b'.repeat(64), created_at: '2026-09-25T12:00:00.000Z', coverage: [{ start_ms: 0, end_ms: 10_000 }],
      words: [
        { id: 'word_opening1', text: 'Opening', start_ms: 0, end_ms: 1000, confidence: 0.98 },
        { id: 'word_secret01', text: 'password', start_ms: 4000, end_ms: 5000, confidence: 0.9 },
        { id: 'word_filler01', text: 'um', start_ms: 6000, end_ms: 6400, confidence: 0.8 },
      ],
      passages: [
        { id: 'passage_open01', start_ms: 0, end_ms: 4_000, text: 'Opening explanation', word_ids: ['word_opening1'] },
        { id: 'passage_secret', start_ms: 4_000, end_ms: 8_000, text: 'password secret@example.com', word_ids: ['word_secret01'] },
      ],
    },
  }],
};

describe('evidence-driven assistance', () => {
  it('builds source-cited trim, highlight, focus, callout and sensitive proposals', () => {
    const result = buildAssistance(storyboard, 3, 5_000);
    expect(result.current_duration_ms).toBe(10_000);
    expect(result.projected_duration_ms).toBe(4_000);
    expect(result.tolerance_met).toBe(true);
    expect(result.proposals.map((proposal) => proposal.kind)).toEqual(expect.arrayContaining(['trim', 'highlight', 'focus', 'callout', 'sensitive', 'cleanup', 'audio']));
    expect(result.proposals.every((proposal) => proposal.citations.length > 0)).toBe(true);
    expect(result.proposals.find((proposal) => proposal.kind === 'sensitive')).toMatchObject({ provenance: 'inferred', effect: { type: 'redaction', opacity: 1, rect: { x: 0, y: 0, width: 1, height: 1 } } });
  });

  it('refuses to invent transcript-backed cuts when evidence is missing', () => {
    const noTranscript = { ...storyboard, scenes: [{ ...storyboard.scenes[0]!, transcript: undefined }] };
    const result = buildAssistance(noTranscript, 0, 5_000);
    expect(result.proposals.some((proposal) => proposal.kind === 'trim')).toBe(false);
    expect(result.blockers.join(' ')).toMatch(/transcript evidence/i);
    expect(result.tolerance_met).toBe(false);
  });
});
