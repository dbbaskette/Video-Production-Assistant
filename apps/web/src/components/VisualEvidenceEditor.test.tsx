import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Scene } from '@vpa/shared';
import { assetsApi, compositionApi, sourceEvidenceApi } from '../lib/api.js';
import { flushPromises, renderComponent } from './component-test-utils.js';
import { VisualEvidenceEditor } from './VisualEvidenceEditor.js';

const source = `asset_${'a'.repeat(64)}`;
const scene: Scene = { id: 'scene-01', name: 'Demo', description: 'Demo', type: 'desktop', recording: { source: 'recordings/demo.mp4', asset_id: source, duration_sec: 8 }, composition: { version: 1, audio_mix: {}, clips: [{ id: 'clip_source-001', source_asset_id: source, source_role: 'screen', source_in_ms: 0, source_out_ms: 8_000, timeline_start_ms: 0, linked_tracks: [] }] } };

async function tick(): Promise<void> { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); }

describe('VisualEvidenceEditor', () => {
  beforeEach(() => {
    vi.spyOn(assetsApi, 'currentRevision').mockResolvedValue(3);
    vi.spyOn(compositionApi, 'execute').mockResolvedValue({ revision: 4 });
    vi.spyOn(sourceEvidenceApi, 'get').mockResolvedValue({ transcript: null, mappedWords: [], evidence: [] });
    vi.spyOn(sourceEvidenceApi, 'transcribe').mockResolvedValue({ transcript: null as never, mappedWords: [] });
    vi.stubGlobal('crypto', { randomUUID: vi.fn().mockReturnValue('00000000-0000-4000-8000-000000000001') });
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = ''; });

  it('adds the first manual text effect, shares selection, and saves without a model call', async () => {
    const view = renderComponent(<VisualEvidenceEditor projectId="p1" scenes={[scene]} />);
    await tick();
    act(() => [...view.container.querySelectorAll('button')].find((button) => button.textContent === '+ text')!.click());
    expect(view.container.textContent).toContain('Unsaved changes');
    expect(view.container.querySelector('input[value="New text"]')).not.toBeNull();
    act(() => [...view.container.querySelectorAll('button')].find((button) => button.textContent === 'Save effects')!.click());
    await flushPromises();
    expect(compositionApi.execute).toHaveBeenCalledWith('p1', 3, [expect.objectContaining({ type: 'visual.effects.set', effects: [expect.objectContaining({ type: 'text', text: 'New text' })] })]);
    expect(sourceEvidenceApi.transcribe).not.toHaveBeenCalled();
    view.unmount();
  });
});
