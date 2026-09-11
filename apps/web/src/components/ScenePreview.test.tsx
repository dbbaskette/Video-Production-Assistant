import { act } from 'react';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import type { Scene } from '@vpa/shared';
import { ScenePreview } from './ScenePreview.js';
import { overlayApi } from '../lib/api.js';
import { renderComponent } from './component-test-utils.js';
const scene: Scene = { id: 's', name: 'Preview', type: 'slide', description: '', recording: { source: 'slide.mp4', duration_sec: 1 } };
const chunks = [{ index: 0, durationSec: 3, hasAudio: true, gapSec: 2 }, { index: 1, durationSec: 4, hasAudio: true }];
beforeEach(() => {
  vi.spyOn(overlayApi, 'colors').mockResolvedValue({ accent: '#fff', textColor: '#fff', bgColor: '#000', source: 'default' });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
});
afterEach(() => { vi.restoreAllMocks(); });
it('uses full narration duration and pauses, retaining time through inspector rerenders', () => {
  const view = renderComponent(<ScenePreview projectId="p" scene={scene} chunks={chunks} />);
  const slider = view.container.querySelector<HTMLInputElement>('input')!;
  expect(slider.max).toBe('9');
  const video = view.container.querySelector('video');
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(slider, '4'); slider.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(view.container.querySelector('output')!.textContent).toContain('4.0 / 9.0');
  expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled(); // silence gap
  view.rerender(<ScenePreview projectId="p" scene={scene} chunks={[...chunks]} />);
  expect(view.container.querySelector('video')).toBe(video);
  expect(slider.value).toBe('4');
  view.unmount();
});
it('keeps original audio on a recorded scene without narration', () => {
  const view = renderComponent(<ScenePreview projectId="p" scene={{ ...scene, type: 'desktop' }} chunks={[]} />);
  expect(view.container.querySelector('video')!.muted).toBe(false);
  expect(view.container.querySelector('video')!.controls).toBe(true);
  view.unmount();
});
