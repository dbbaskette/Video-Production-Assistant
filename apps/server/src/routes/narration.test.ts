import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { ProjectStore } from '../services/project/store.js';
import { saveStoryboard, loadStoryboard } from '../services/storyboard/index.js';
import { TtsService, createFakeTtsProvider } from '../services/tts/index.js';
import { registerNarrationRoutes } from './narration.js';
import type { Storyboard } from '@vpa/shared';

async function buildTestServer() {
  const home = await mkdtemp(path.join(tmpdir(), 'vpa-narr-routes-'));
  const projects = await mkdtemp(path.join(tmpdir(), 'vpa-narr-projects-'));
  const store = new ProjectStore({ vpaHome: home, projectsDefault: projects });
  const tts = new TtsService();
  tts.register(createFakeTtsProvider());

  const llm = {
    async complete() {
      return { text: 'fake llm response' };
    },
  };

  const app = Fastify();
  const workspaceRoot = path.resolve(import.meta.dirname, '../../../..');
  await app.register(async (i) =>
    registerNarrationRoutes(i, { store, tts, llm, workspaceRoot, vpaHome: home }),
  );
  return { app, store, tts, llm, home, projects };
}

function makeSampleStoryboard(projectId: string): Storyboard {
  return {
    schema_version: 1,
    project: {
      id: projectId,
      name: 'test-proj',
      created: new Date().toISOString(),
      objective: 'Demo narration',
    },
    scenes: [
      {
        id: 'scene-01',
        name: 'Intro',
        description: 'Introduction',
        type: 'desktop',
        narration: {
          script: '[warm] Welcome to this demo. [confident] Let me show you how it works.',
        },
      },
      {
        id: 'scene-02',
        name: 'Setup',
        description: 'Setting up',
        type: 'terminal',
        // No script
      },
    ],
  };
}

describe('narration routes', () => {
  let ctx: Awaited<ReturnType<typeof buildTestServer>>;
  let projectId: string;
  let projectPath: string;

  beforeEach(async () => {
    ctx = await buildTestServer();
    const project = await ctx.store.create({ name: 'test-proj', objective: 'Demo narration' });
    projectId = project.id;
    projectPath = project.path;
  });

  afterEach(async () => {
    await ctx.app.close();
    await rm(ctx.home, { recursive: true, force: true });
    await rm(ctx.projects, { recursive: true, force: true });
  });

  // --- TTS Engine routes ---
  it('GET /api/tts/engines returns available engines', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/tts/engines' });
    expect(res.statusCode).toBe(200);
    const engines = res.json();
    expect(Array.isArray(engines)).toBe(true);
    expect(engines.length).toBeGreaterThan(0);
    expect(engines[0].id).toBe('fake');
    expect(engines[0].voices.length).toBeGreaterThan(0);
  });

  // --- Voice profile routes ---
  it('GET /api/voices returns profiles (with default)', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/voices' });
    expect(res.statusCode).toBe(200);
    const profiles = res.json();
    expect(Array.isArray(profiles)).toBe(true);
    expect(profiles.length).toBeGreaterThanOrEqual(1);
  });

  it('POST /api/voices creates a new profile', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/voices',
      payload: { name: 'My Voice', engine: 'fake', voice: 'bob', speed: 1.2 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe('my-voice');
    expect(body.name).toBe('My Voice');
    expect(body.engine).toBe('fake');
  });

  it('POST /api/voices returns 400 without required fields', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/voices',
      payload: { name: 'No Engine' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('DELETE /api/voices/:profileId deletes a profile', async () => {
    // Create first
    await ctx.app.inject({
      method: 'POST',
      url: '/api/voices',
      payload: { name: 'Delete Me', engine: 'fake', voice: 'carol' },
    });

    const res = await ctx.app.inject({
      method: 'DELETE',
      url: '/api/voices/delete-me',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().deleted).toBe(true);
  });

  it('DELETE /api/voices/:profileId returns 404 for nonexistent', async () => {
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: '/api/voices/nonexistent',
    });
    expect(res.statusCode).toBe(404);
  });

  // --- Narration routes ---
  it('GET narration state returns empty state when no narration exists', async () => {
    const sb = makeSampleStoryboard(projectId);
    await saveStoryboard(projectPath, sb);

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/scenes/scene-01/narration`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sceneId).toBe('scene-01');
    expect(body.hasScript).toBe(true);
    expect(body.hasAudio).toBe(false);
    expect(body.audio).toBeNull();
  });

  it('POST generate creates narration with audio + subtitles', async () => {
    const sb = makeSampleStoryboard(projectId);
    await saveStoryboard(projectPath, sb);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/narration/generate`,
      payload: { engine: 'fake', voice: 'alice', speed: 1.0 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.audioPath).toBe('narration/scene-01.mp3');
    expect(body.srtPath).toBe('narration/scene-01.srt');
    expect(body.vttPath).toBe('narration/scene-01.vtt');
    expect(body.durationSec).toBeGreaterThan(0);
    expect(body.timingCount).toBeGreaterThan(0);

    // Verify storyboard was updated
    const updated = await loadStoryboard(projectPath);
    const scene = updated!.scenes.find((s) => s.id === 'scene-01');
    expect(scene?.narration?.audio).toBe('narration/scene-01.mp3');
    expect(scene?.narration?.tts?.engine).toBe('fake');
  });

  it('POST generate returns 400 when engine/voice missing', async () => {
    const sb = makeSampleStoryboard(projectId);
    await saveStoryboard(projectPath, sb);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/narration/generate`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('invalid_request');
  });

  it('POST generate returns 400 when scene has no script', async () => {
    const sb = makeSampleStoryboard(projectId);
    await saveStoryboard(projectPath, sb);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-02/narration/generate`,
      payload: { engine: 'fake', voice: 'alice' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('missing_script');
  });

  it('GET audio returns 404 before generation', async () => {
    const sb = makeSampleStoryboard(projectId);
    await saveStoryboard(projectPath, sb);

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/scenes/scene-01/narration/audio`,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('no_audio');
  });

  it('GET audio streams MP3 after generation', async () => {
    const sb = makeSampleStoryboard(projectId);
    await saveStoryboard(projectPath, sb);

    // Generate first
    await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/narration/generate`,
      payload: { engine: 'fake', voice: 'alice' },
    });

    // Stream audio
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/scenes/scene-01/narration/audio`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('audio/mpeg');
    expect(Number(res.headers['content-length'])).toBeGreaterThan(0);
  });

  it('returns 404 for nonexistent scene', async () => {
    const sb = makeSampleStoryboard(projectId);
    await saveStoryboard(projectPath, sb);

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/scenes/no-such/narration`,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('scene_not_found');
  });

  it('returns 404 when no storyboard exists', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/narration/generate`,
      payload: { engine: 'fake', voice: 'alice' },
    });
    expect(res.statusCode).toBe(404);
  });
});
