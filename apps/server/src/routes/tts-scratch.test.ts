import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTtsScratchRoutes } from './tts-scratch.js';
import { TtsService, createFakeTtsProvider } from '../services/tts/index.js';
import { saveProfile } from '../services/voice-profile/index.js';

describe('TTS scratch routes', () => {
  let home: string;
  let app: ReturnType<typeof Fastify>;
  let tts: TtsService;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'vpa-tts-scratch-'));
    app = Fastify({ logger: false });
    tts = new TtsService();
    tts.register(createFakeTtsProvider());
    await registerTtsScratchRoutes(app, { vpaHome: home, tts });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await rm(home, { recursive: true, force: true });
  });

  it('resolves a voice profile and returns a downloadable artifact', async () => {
    await saveProfile(home, {
      id: 'presenter',
      name: 'Presenter',
      engine: 'fake',
      voice: 'bob',
      speed: 1.25,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/tts/scratch',
      payload: { profile: 'presenter', text: 'A standalone narration.' },
    });

    expect(response.statusCode).toBe(200);
    const clip = response.json();
    expect(clip).toMatchObject({
      engine: 'fake',
      voice: 'bob',
      speed: 1.25,
      profile: 'presenter',
      audioUrl: `/api/tts/scratch/${clip.id}/audio`,
    });
    expect(
      (await readFile(join(home, 'tts-scratch', `${clip.id}.${clip.format}`))).length,
    ).toBeGreaterThan(0);
  });

  it('rejects unsupported speed before invoking the provider', async () => {
    const generate = vi.spyOn(tts, 'generate');
    const response = await app.inject({
      method: 'POST',
      url: '/api/tts/scratch',
      payload: { engine: 'fake', voice: 'alice', speed: 2.5, text: 'Too fast.' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: 'unsupported_speed',
      supported: { min: 0.5, max: 2, default: 1 },
    });
    expect(generate).not.toHaveBeenCalled();
  });

  it('rejects a voice that the selected engine does not advertise', async () => {
    const generate = vi.spyOn(tts, 'generate');
    const response = await app.inject({
      method: 'POST',
      url: '/api/tts/scratch',
      payload: { engine: 'fake', voice: 'missing', text: 'No fallback.' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('voice_not_found');
    expect(generate).not.toHaveBeenCalled();
  });

  it.each([
    [{ profile: 'missing', text: 'No profile.' }, 'profile_not_found'],
    [{ engine: 'missing', voice: 'alice', text: 'No engine.' }, 'engine_unavailable'],
    [{ engine: 'fake', voice: 'alice', text: 'Styled.', expressiveness: 'heavy' }, 'unsupported_expressiveness'],
    [{ engine: 'fake', voice: 'alice', text: 'x'.repeat(5_001) }, 'text_too_long'],
  ])('rejects unsupported selection before provider work: %s', async (payload, code) => {
    const generate = vi.spyOn(tts, 'generate');
    const response = await app.inject({
      method: 'POST',
      url: '/api/tts/scratch',
      payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe(code);
    expect(generate).not.toHaveBeenCalled();
  });
});
