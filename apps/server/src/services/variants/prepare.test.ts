import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { OutputVariant, Storyboard } from '@vpa/shared';
import { saveStoryboard } from '../storyboard/index.js';
import { prepareVariantSnapshot } from './prepare.js';

describe('variant snapshot preparation', () => {
  let root = '';
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  it('materializes approved ranges and accepted localized captions without changing the source definition', async () => {
    root = await mkdtemp(join(tmpdir(), 'vpa-variant-prepare-'));
    const assetId = `asset_${'a'.repeat(64)}`;
    const storyboard: Storyboard = {
      schema_version: 1,
      project: { id: '11111111-1111-4111-8111-111111111111', name: 'demo', created: '2026-09-25T12:00:00.000Z' },
      scenes: [{
        id: 'scene-01', name: 'Demo', description: 'Demo', type: 'desktop',
        composition: { version: 1, audio_mix: {}, clips: [{ id: 'clip_source-001', source_asset_id: assetId, source_role: 'screen', source_in_ms: 0, source_out_ms: 10_000, timeline_start_ms: 0, linked_tracks: [] }] },
        editorial_ranges: [{ id: 'range_highlight-001', kind: 'highlight', clip_instance_id: 'clip_source-001', source_asset_id: assetId, source_in_ms: 2_000, source_out_ms: 6_000, title: 'Highlight', rationale: 'Reviewed', accepted_at: '2026-09-25T12:00:00.000Z' }],
        transcript: { version: 1, source_asset_id: assetId, source_sha256: 'a'.repeat(64), language: 'en', provider: 'gemini', model: 'gemini-test', settings_hash: 'b'.repeat(64), created_at: '2026-09-25T12:00:00.000Z', coverage: [{ start_ms: 0, end_ms: 10_000 }], words: [{ id: 'word_hello01', text: 'Hello', start_ms: 2_000, end_ms: 3_000 }], passages: [{ id: 'passage_hello01', start_ms: 2_000, end_ms: 6_000, text: 'Hello', word_ids: ['word_hello01'] }] },
      }],
    };
    await saveStoryboard(root, storyboard);
    const variant: OutputVariant = {
      version: 1, id: 'variant_spanish-001', name: 'Spanish portrait', aspect_ratio: '9:16', crop: { mode: 'cover', focus_x: 0.5, focus_y: 0.5 }, safe_area: { top: 0.05, right: 0.05, bottom: 0.05, left: 0.05 },
      selected_ranges: [{ scene_id: 'scene-01', range_id: 'range_highlight-001' }], source_language: 'en', target_language: 'es',
      captions: [{ id: 'caption_spanish-001', scene_id: 'scene-01', source_asset_id: assetId, source_in_ms: 2_000, source_out_ms: 6_000, source_text: 'Hello', text: 'Hola', source_language: 'en', target_language: 'es', provider: 'manual', model: 'manual', estimated_cost_usd: 0, pronunciation_notes: 'Reviewed', accepted: true }],
      replace_narration: false, narration_replacement: null, source_revision: 0, source_brand: null, created_at: '2026-09-25T12:00:00.000Z', updated_at: '2026-09-25T12:00:00.000Z',
    };
    const prepared = await prepareVariantSnapshot(root, variant);
    expect(prepared.scenes[0]?.composition?.clips[0]).toMatchObject({ source_in_ms: 2_000, source_out_ms: 6_000, timeline_start_ms: 0 });
    expect(prepared.scenes[0]?.narration).toBeUndefined();
    const subtitle = prepared.scenes[0]?.transcript?.subtitles?.srt;
    expect(subtitle).toBeTruthy();
    expect(await readFile(join(root, subtitle!), 'utf8')).toContain('Hola');
    expect(storyboard.scenes[0]?.composition?.clips[0]?.source_in_ms).toBe(0);
  });
});
