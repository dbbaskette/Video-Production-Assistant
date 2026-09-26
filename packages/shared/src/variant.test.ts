import { describe, expect, it } from 'vitest';
import { OutputVariantDraftSchema, OutputVariantSchema } from './variant.js';

describe('output variant contracts', () => {
  it('accepts bounded reproducible variant definitions and rejects unsafe margins', () => {
    const draft = {
      id: 'variant_portrait-001', name: 'Portrait', aspect_ratio: '9:16',
      crop: { mode: 'cover', focus_x: 0.5, focus_y: 0.4 },
      safe_area: { top: 0.08, right: 0.06, bottom: 0.08, left: 0.06 },
      selected_ranges: [], source_language: 'en', target_language: null,
      captions: [], replace_narration: false, narration_replacement: null,
    } as const;
    expect(OutputVariantDraftSchema.parse(draft).aspect_ratio).toBe('9:16');
    expect(OutputVariantSchema.safeParse({ ...draft, version: 1, source_revision: 2, source_brand: null, created_at: '2026-09-25T12:00:00.000Z', updated_at: '2026-09-25T12:00:00.000Z' }).success).toBe(true);
    expect(OutputVariantDraftSchema.safeParse({ ...draft, safe_area: { ...draft.safe_area, left: 0.5 } }).success).toBe(false);
  });
});
