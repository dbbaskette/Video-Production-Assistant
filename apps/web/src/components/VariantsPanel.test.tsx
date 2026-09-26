import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { Storyboard, VariantValidation } from '@vpa/shared';
import { variantsApi } from '../lib/api.js';
import { renderComponent } from './component-test-utils.js';
import { VariantsPanel } from './VariantsPanel.js';

const assetId = `asset_${'a'.repeat(64)}`;
const storyboard: Storyboard = {
  schema_version: 1,
  project: { id: '11111111-1111-4111-8111-111111111111', name: 'demo', created: '2026-09-25T12:00:00.000Z' },
  scenes: [{
    id: 'scene-01', name: 'Demo', description: 'Demo', type: 'desktop',
    editorial_ranges: [{ id: 'range_highlight-001', kind: 'highlight', clip_instance_id: 'clip_source-001', source_asset_id: assetId, source_in_ms: 0, source_out_ms: 1_000, title: 'Opening', rationale: 'Reviewed', accepted_at: '2026-09-25T12:00:00.000Z' }],
    transcript: { version: 1, source_asset_id: assetId, source_sha256: 'a'.repeat(64), language: 'en', provider: 'gemini', model: 'gemini-test', settings_hash: 'b'.repeat(64), created_at: '2026-09-25T12:00:00.000Z', coverage: [{ start_ms: 0, end_ms: 1_000 }], words: [{ id: 'word_hello01', text: 'Hello', start_ms: 0, end_ms: 1_000 }], passages: [{ id: 'passage_hello01', start_ms: 0, end_ms: 1_000, text: 'Hello', word_ids: ['word_hello01'] }] },
  }],
};
const created: VariantValidation = {
  variant: { version: 1, id: 'variant_created-001', name: 'Portrait cut', aspect_ratio: '9:16', crop: { mode: 'cover', focus_x: 0.5, focus_y: 0.5 }, safe_area: { top: 0.05, right: 0.05, bottom: 0.05, left: 0.05 }, selected_ranges: [{ scene_id: 'scene-01', range_id: 'range_highlight-001' }], source_language: 'en', target_language: 'es', captions: [], replace_narration: false, narration_replacement: null, source_revision: 0, source_brand: null, created_at: '2026-09-25T12:00:00.000Z', updated_at: '2026-09-25T12:00:00.000Z' },
  current_revision: 0, stale: false, dimensions: { width: 1080, height: 1920 }, blockers: [], warnings: [], estimated_cost_usd: 0,
};

describe('VariantsPanel', () => {
  it('creates an explicit source-linked language/highlight variant and selects it for the next render', async () => {
    vi.spyOn(variantsApi, 'list').mockResolvedValue({ variants: [] });
    vi.spyOn(variantsApi, 'create').mockResolvedValue(created);
    const onSelect = vi.fn();
    const view = renderComponent(<VariantsPanel projectId="project-1" storyboard={storyboard} selectedVariantId={null} onSelect={onSelect} />);
    await vi.waitFor(() => expect(variantsApi.list).toHaveBeenCalled());
    const language = view.container.querySelector('[aria-label="Target language"]') as HTMLInputElement;
    const range = view.container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(language, 'es');
      language.dispatchEvent(new Event('input', { bubbles: true }));
      range.click();
    });
    const createButton = [...view.container.querySelectorAll('button')].find((button) => button.textContent === 'Create pinned variant')!;
    await act(async () => createButton.click());
    await vi.waitFor(() => expect(variantsApi.create).toHaveBeenCalledWith('project-1', expect.objectContaining({
      aspect_ratio: '9:16', target_language: 'es', selected_ranges: [{ scene_id: 'scene-01', range_id: 'range_highlight-001' }],
      captions: [expect.objectContaining({ source_text: 'Hello', target_language: 'es', accepted: false })],
    })));
    expect(onSelect).toHaveBeenCalledWith('variant_created-001');
    view.unmount();
  });
});
