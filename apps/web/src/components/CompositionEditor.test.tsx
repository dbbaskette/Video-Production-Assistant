import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Asset, Scene } from '@vpa/shared';
import { assetsApi, compositionApi, sceneRenderApi } from '../lib/api.js';
import { flushPromises, renderComponent } from './component-test-utils.js';
import { CompositionEditor } from './CompositionEditor.js';

const screenId = `asset_${'a'.repeat(64)}`;
const micId = `asset_${'b'.repeat(64)}`;
const now = '2026-09-25T12:00:00.000Z';
const assets: Asset[] = [
  { id: screenId, checksum: 'a'.repeat(64), original_name: 'screen.webm', source: '.vpa/assets/originals/screen.webm', origin: 'source', media_kind: 'video', mime_type: 'video/webm', size_bytes: 10, imported_at: now, duration_sec: 8, timing_origin_ms: 0, source_role: 'screen', preparation: { status: 'ready', attempts: 1, updated_at: now } },
  { id: micId, checksum: 'b'.repeat(64), original_name: 'mic.webm', source: '.vpa/assets/originals/mic.webm', origin: 'source', media_kind: 'audio', mime_type: 'audio/webm', size_bytes: 10, imported_at: now, duration_sec: 7.98, timing_origin_ms: 20, source_role: 'microphone', preparation: { status: 'ready', attempts: 1, updated_at: now } },
];

const scene: Scene = {
  id: 'scene-01', name: 'Demo', description: 'Demo', type: 'desktop',
  recording: { source: assets[0]!.source, asset_id: screenId, duration_sec: 8 },
  sources: [{ asset_id: screenId, role: 'screen', timing_origin_ms: 0 }, { asset_id: micId, role: 'microphone', timing_origin_ms: 20 }],
};

async function waitFor(assertion: () => void): Promise<void> {
  let failure: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });
    try { assertion(); return; } catch (error) { failure = error; }
  }
  throw failure;
}

describe('CompositionEditor', () => {
  beforeEach(() => {
    vi.spyOn(assetsApi, 'list').mockResolvedValue(assets);
    vi.spyOn(assetsApi, 'currentRevision').mockResolvedValue(4);
    vi.spyOn(compositionApi, 'execute').mockResolvedValue({ revision: 5 });
    vi.spyOn(sceneRenderApi, 'start').mockResolvedValue({ durationSec: 8, hasNarration: false, hadLowerThirds: false, combinedRel: 'renders/scenes/scene-01/combined.mp4', overlayRel: 'renders/scenes/scene-01/overlay.mp4', narrationRel: null });
    vi.stubGlobal('crypto', { randomUUID: vi.fn().mockReturnValue('00000000-0000-4000-8000-000000000001') });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = ''; });

  it('initializes linked immutable tracks through the shared revision command API', async () => {
    const view = renderComponent(<CompositionEditor projectId="p1" scenes={[scene]} />);
    const toggle = [...view.container.querySelectorAll('button')].find((button) => button.textContent?.includes('Clip editor'))!;
    act(() => toggle.click());
    await waitFor(() => expect([...view.container.querySelectorAll('button')].find((button) => button.textContent === 'Create editable composition')?.disabled).toBe(false));
    const initialize = [...view.container.querySelectorAll('button')].find((button) => button.textContent === 'Create editable composition')!;
    act(() => initialize.click());
    await flushPromises();
    expect(compositionApi.execute).toHaveBeenCalledWith('p1', 4, [expect.objectContaining({
      type: 'composition.set',
      sceneId: 'scene-01',
      composition: expect.objectContaining({
        clips: [expect.objectContaining({ source_asset_id: screenId, source_in_ms: 0, source_out_ms: 8_000, linked_tracks: [{ asset_id: micId, role: 'microphone', source_offset_ms: 20 }] })],
        audio_mix: { original: { gain_db: 0, mute: true, fade_in_ms: 0, fade_out_ms: 0 } },
      }),
    })]);
    view.unmount();
  });

  it('sends clip duplication and audio controls as validated commands', async () => {
    const composed: Scene = { ...scene, composition: { version: 1, clips: [{ id: 'clip_original-0001', source_asset_id: screenId, source_role: 'screen', source_in_ms: 0, source_out_ms: 8_000, timeline_start_ms: 0, linked_tracks: [{ asset_id: micId, role: 'microphone', source_offset_ms: 20 }] }], audio_mix: {} } };
    const view = renderComponent(<CompositionEditor projectId="p1" scenes={[composed]} />);
    act(() => [...view.container.querySelectorAll('button')].find((button) => button.textContent?.includes('Clip editor'))!.click());
    await waitFor(() => expect(view.client.getQueryData(['revision', 'p1'])).toBe(4));
    act(() => [...view.container.querySelectorAll('button')].find((button) => button.textContent === 'Duplicate')!.click());
    await waitFor(() => expect(compositionApi.execute).toHaveBeenCalledWith('p1', 4, [expect.objectContaining({ type: 'clip.duplicate', clipId: 'clip_original-0001' })]));
    vi.mocked(compositionApi.execute).mockClear();
    const gain = view.container.querySelector('input[aria-label="Microphone gain"]') as HTMLInputElement;
    const mixRow = gain.closest('div')!;
    act(() => [...mixRow.querySelectorAll('button')].find((button) => button.textContent === 'Save')!.click());
    await waitFor(() => expect(compositionApi.execute).toHaveBeenCalledWith('p1', 4, [{ type: 'audio.mix.set', sceneId: 'scene-01', role: 'microphone', settings: { gain_db: 0, mute: false, fade_in_ms: 0, fade_out_ms: 0 } }]));
    view.unmount();
  });

  it('renders preview through the same combined scene artifact used for export', async () => {
    const composed: Scene = { ...scene, composition: { version: 1, clips: [{ id: 'clip_original-0001', source_asset_id: screenId, source_role: 'screen', source_in_ms: 0, source_out_ms: 8_000, timeline_start_ms: 0, linked_tracks: [] }], audio_mix: {} } };
    const view = renderComponent(<CompositionEditor projectId="p1" scenes={[composed]} />);
    act(() => [...view.container.querySelectorAll('button')].find((button) => button.textContent?.includes('Clip editor'))!.click());
    await waitFor(() => expect(view.client.getQueryData(['revision', 'p1'])).toBe(4));
    act(() => [...view.container.querySelectorAll('button')].find((button) => button.textContent === 'Render preview')!.click());
    await waitFor(() => expect(sceneRenderApi.start).toHaveBeenCalledWith('p1', 'scene-01', { audioMode: 'mix', burnSubtitles: false }));
    const video = view.container.querySelector('video');
    expect(video?.getAttribute('src')).toContain('/api/projects/p1/scenes/scene-01/render/file/combined?inline=1&t=');
    view.unmount();
  });
});
