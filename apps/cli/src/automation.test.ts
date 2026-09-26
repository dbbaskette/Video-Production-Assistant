import { describe, expect, it, vi } from 'vitest';
import { VpaAutomationClient } from './automation.js';
import type { HttpClient } from './client.js';

function fakeClient(json: HttpClient['json']): HttpClient {
  return { json, bytes: async () => new Uint8Array() };
}

describe('VpaAutomationClient', () => {
  it('keeps narration discovery on the same API contract used by the CLI', async () => {
    const catalog = [{ id: 'fake', displayName: 'Fake', ready: true, voices: [{ id: 'default', name: 'Default' }], supportedEmotives: [], expressiveTags: [], capabilities: { speed: { min: 0.5, max: 2, default: 1 }, expressiveness: [], multiSpeaker: false, outputFormats: ['mp3'], timings: 'estimated', subtitles: true, maxInputChars: 5000 } }];
    const json = vi.fn(async () => catalog) as HttpClient['json'];
    const automation = new VpaAutomationClient(fakeClient(json));

    expect(await automation.listNarrationEngines()).toEqual(catalog);
    expect(await automation.listNarrationVoices('fake')).toEqual([{ engine: 'fake', id: 'default', name: 'Default' }]);
    expect(json).toHaveBeenNthCalledWith(1, 'GET', '/api/tts/engines');
    expect(json).toHaveBeenNthCalledWith(2, 'GET', '/api/tts/engines');
  });

  it('forwards stable idempotency keys to durable narration and render submissions', async () => {
    const json = vi.fn(async () => ({ jobId: '11111111-1111-4111-8111-111111111111', status: 'running' })) as HttpClient['json'];
    const automation = new VpaAutomationClient(fakeClient(json));

    await automation.startProjectNarration('project one', {
      engine: 'fake', voice: 'default', speed: 1, expressiveness: 'medium', overwrite: false,
    }, 'narration-request-1');
    await automation.startProjectRender('project one', { quality: 'draft' }, 'render-request-1');

    expect(json).toHaveBeenNthCalledWith(
      1,
      'POST',
      '/api/projects/project%20one/narration/generate-project',
      { engine: 'fake', voice: 'default', speed: 1, expressiveness: 'medium', overwrite: false },
      { headers: { 'Idempotency-Key': 'narration-request-1' } },
    );
    expect(json).toHaveBeenNthCalledWith(
      2,
      'POST',
      '/api/projects/project%20one/render',
      { quality: 'draft' },
      { headers: { 'Idempotency-Key': 'render-request-1' } },
    );
  });
});
