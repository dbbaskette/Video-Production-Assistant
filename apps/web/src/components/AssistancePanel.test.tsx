import { describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { renderComponent } from './component-test-utils.js';
import { assistanceApi } from '../lib/api.js';
import { AssistancePanel } from './AssistancePanel.js';

describe('AssistancePanel', () => {
  it('shows evidence and applies only after explicit acceptance', async () => {
    vi.spyOn(assistanceApi, 'inspect').mockResolvedValue({
      revision: 4, current_duration_ms: 30_000, target_duration_ms: 15_000, projected_duration_ms: 12_000, tolerance_met: true, blockers: [],
      proposals: [{ id: 'proposal_12345678', kind: 'trim', scene_id: 'scene-01', clip_id: 'clip_source-001', title: 'Trim Demo', rationale: 'Source-backed cut.', confidence: 0.9, provenance: 'observed', status: 'pending', warnings: [], source_in_ms: 0, source_out_ms: 12_000, omitted_text: 'Extra material', citations: [{ scene_id: 'scene-01', source_asset_id: `asset_${'a'.repeat(64)}`, source_in_ms: 0, source_out_ms: 12_000, evidence: 'transcript', excerpt: 'Opening', confidence: 0.9, provenance: 'observed' }] }],
    });
    vi.spyOn(assistanceApi, 'apply').mockResolvedValue({ revision: 5 });
    const view = renderComponent(<AssistancePanel projectId="p1" />);
    const button = (label: string) => [...view.container.querySelectorAll('button')].find((item) => item.textContent === label)!;
    await act(async () => button('Build proposals').click());
    await vi.waitFor(() => expect(view.container.textContent).toContain('Trim Demo'));
    expect(assistanceApi.apply).not.toHaveBeenCalled();
    await act(async () => button('Accept proposal').click());
    await vi.waitFor(() => expect(assistanceApi.apply).toHaveBeenCalledWith('p1', 'proposal_12345678', expect.objectContaining({ expectedRevision: 4, targetDurationSec: 180 })));
  });
});
