import { expect, it } from 'vitest';
import { renderCapabilityFailures } from './RenderCapabilities.js';
import type { SetupProbe } from '../lib/api.js';
it('blocks only dependencies required by this export', () => {
  const probes: SetupProbe[] = ['ffmpeg-drawtext', 'tts-provider'].map(id => ({ id, label: id, status: 'fail', ranAt: 0, message: 'Unavailable' }));
  expect(renderCapabilityFailures(probes, false)).toHaveLength(0);
  expect(renderCapabilityFailures(probes, true).map(p => p.id)).toEqual(['ffmpeg-drawtext']);
  probes.push({ id: 'ffmpeg-present', label: 'ffmpeg', status: 'fail', ranAt: 0, message: 'Missing' });
  expect(renderCapabilityFailures(probes, false).map(p => p.id)).toEqual(['ffmpeg-present']);
});
