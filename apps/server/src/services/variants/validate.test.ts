import { describe, expect, it } from 'vitest';
import type { OutputVariant, Project, Storyboard } from '@vpa/shared';
import { mapRectToVariant, validateVariant, variantDimensions } from './validate.js';

const project = { id: '11111111-1111-4111-8111-111111111111', name: 'demo', path: '/tmp/demo', created: '2026-09-25T12:00:00.000Z', brand: null, model_routing: {} } satisfies Project;
const variant: OutputVariant = { version: 1, id: 'variant_portrait-001', name: 'Portrait', aspect_ratio: '9:16', crop: { mode: 'cover', focus_x: 0.5, focus_y: 0.5 }, safe_area: { top: 0.05, right: 0.05, bottom: 0.05, left: 0.05 }, selected_ranges: [], source_language: 'en', target_language: null, captions: [], replace_narration: false, narration_replacement: null, source_revision: 2, source_brand: null, created_at: '2026-09-25T12:00:00.000Z', updated_at: '2026-09-25T12:00:00.000Z' };
const storyboard: Storyboard = { schema_version: 1, project: { id: project.id, name: project.name, created: project.created }, scenes: [] };

describe('variant validation', () => {
  it('reports correct dimensions and explicit staleness', () => {
    expect(variantDimensions('16:9', '1080p')).toEqual({ width: 1920, height: 1080 });
    expect(variantDimensions('1:1', '1080p')).toEqual({ width: 1080, height: 1080 });
    expect(variantDimensions('9:16', '1080p')).toEqual({ width: 1080, height: 1920 });
    expect(validateVariant(variant, storyboard, project, 3)).toMatchObject({ stale: true, blockers: [expect.stringMatching(/rebase/i)] });
  });

  it('maps source rectangles through cover reframing', () => {
    const mapped = mapRectToVariant({ x: 0.4, y: 0.2, width: 0.2, height: 0.2 }, variant);
    expect(mapped.x).toBeCloseTo(0.18, 1);
    expect(mapped.width).toBeCloseTo(0.64, 1);
  });
});
