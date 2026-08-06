import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { ProjectStore } from '../services/project/store.js';
import { saveStoryboard, loadStoryboard } from '../services/storyboard/index.js';
import { TtsService, createFakeTtsProvider } from '../services/tts/index.js';
import { registerNarrationRoutes } from './narration.js';
import type { Storyboard } from '@vpa/shared';
import type { LlmClient } from '../services/llm/index.js';
import { ModelRoutingError, type ModelRouter } from '../services/llm/model-router.js';
import { jobQueue } from '../lib/job-queue.js';

async function waitForJobStatus(jobId: string, target: 'completed' | 'failed'): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const status = jobQueue.get(jobId)?.status;
    if (status === target) return;
    if (status === 'failed' && target !== 'failed') {
      throw new Error(`Job failed: ${jobQueue.get(jobId)?.error}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for job ${jobId} to reach ${target}`);
}

async function buildTestServer(writerOverride?: LlmClient) {
  const home = await mkdtemp(path.join(tmpdir(), 'vpa-narr-routes-'));
  const projects = await mkdtemp(path.join(tmpdir(), 'vpa-narr-projects-'));
  const store = new ProjectStore({ vpaHome: home, projectsDefault: projects });
  const tts = new TtsService();
  tts.register(createFakeTtsProvider());

  const writer = writerOverride ?? {
    async complete() {
      return { text: 'fake llm response' };
    },
  };
  const general: LlmClient = {
    async complete() {
      return { text: 'source summary' };
    },
  };
  const resolveText = vi.fn(async (role: 'writing' | 'general') => ({
    client: role === 'writing' ? writer : general,
    summary: {
      role,
      scope: 'project' as const,
      entry_id: `${role}-model`,
      provider: 'fake' as const,
      model: `fake-${role}`,
      name: role,
      capabilities: { text: true, image: false, video: false },
      ready: true as const,
    },
  }));
  const router = { resolveText } as unknown as ModelRouter;

  const app = Fastify();
  const workspaceRoot = path.resolve(import.meta.dirname, '../../../..');
  await app.register(async (i) =>
    registerNarrationRoutes(i, { store, tts, router, workspaceRoot, vpaHome: home }),
  );
  return { app, store, tts, writer, general, resolveText, home, projects };
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

  it('POST project narration generates scripted scenes and skips empty scripts', async () => {
    await saveStoryboard(projectPath, makeSampleStoryboard(projectId));

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/narration/generate-project`,
      payload: {
        engine: 'fake',
        voice: 'alice',
        speed: 1,
        expressiveness: 'medium',
        overwrite: false,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'running' });
    await waitForJobStatus(res.json().jobId, 'completed');
    expect(jobQueue.get(res.json().jobId)?.result).toMatchObject({
      totalScenes: 2,
      generatedScenes: 1,
      noScriptScenes: 1,
      failedScenes: 0,
    });
  });

  it.each([
    null,
    'bad',
    { engine: 'fake', voice: 'alice', speed: 1, expressiveness: 'medium', overwrite: false, extra: true },
    { engine: 'fake', voice: 'alice', speed: 0.49, expressiveness: 'medium', overwrite: false },
    { engine: 'fake', voice: 'alice', speed: 2.01, expressiveness: 'medium', overwrite: false },
    { engine: 'fake', voice: 'alice', speed: 1, expressiveness: 'extreme', overwrite: false },
    { engine: 'fake', voice: 'alice', speed: 1, expressiveness: 'medium', overwrite: 'yes' },
    { engine: 'unknown', voice: 'alice', speed: 1, expressiveness: 'medium', overwrite: false },
    { engine: 'fake', voice: 'unknown', speed: 1, expressiveness: 'medium', overwrite: false },
  ])('rejects invalid project narration input %#', async (payload) => {
    await saveStoryboard(projectPath, makeSampleStoryboard(projectId));
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/narration/generate-project`,
      payload: payload === null || typeof payload === 'string' ? JSON.stringify(payload) : payload,
      headers: { 'content-type': 'application/json' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('invalid_request');
  });

  it('allows only one active project narration job per project', async () => {
    await saveStoryboard(projectPath, makeSampleStoryboard(projectId));
    const active = jobQueue.create('narration-generate-project', { projectId, label: 'Narration' });
    jobQueue.setStatus(active.id, 'running');

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/narration/generate-project`,
      payload: { engine: 'fake', voice: 'alice', overwrite: false },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('narration_job_active');
    jobQueue.setStatus(active.id, 'cancelled');
  });

  it('retains project ownership until a cancellation reaches a safe boundary', async () => {
    let release!: () => void;
    let started!: () => void;
    const began = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    ctx.tts.register({
      id: 'slow',
      displayName: 'Slow',
      voices: [{ id: 'voice', name: 'Voice' }],
      supportedEmotives: new Set(),
      expressiveTags: [],
      async generate() {
        started();
        await gate;
        return { audio: Buffer.from('audio'), durationSec: 1, timings: [] };
      },
    });
    await saveStoryboard(projectPath, makeSampleStoryboard(projectId));
    const startedJob = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/narration/generate-project`,
      payload: { engine: 'slow', voice: 'voice', overwrite: false },
    });
    await began;

    const cancelled = await ctx.app.inject({
      method: 'POST',
      url: `/api/jobs/${startedJob.json().jobId}/cancel`,
    });
    expect(cancelled.json()).toMatchObject({ cancelled: true, status: 'cancelling' });
    expect(jobQueue.get(startedJob.json().jobId)?.status).toBe('cancelling');

    const overlappingProject = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/narration/generate-project`,
      payload: { engine: 'slow', voice: 'voice', overwrite: false },
    });
    expect(overlappingProject.statusCode).toBe(409);
    const overlappingScene = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/narration/generate-all`,
      payload: { engine: 'slow', voice: 'voice' },
    });
    expect(overlappingScene.statusCode).toBe(409);

    release();
    await waitForJobStatus(startedJob.json().jobId, 'completed');
    expect(jobQueue.get(startedJob.json().jobId)?.result).toMatchObject({ cancelled: true });
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
    expect(ctx.resolveText).not.toHaveBeenCalled();
  });

  it('returns a stable writing routing error without changing narration', async () => {
    const sb = makeSampleStoryboard(projectId);
    sb.scenes[0]!.narration!.audio = 'narration/existing.mp3';
    await saveStoryboard(projectPath, sb);
    ctx.resolveText.mockRejectedValueOnce(new ModelRoutingError(
      'model_unavailable',
      'writing',
      'project',
      'The assigned writing model is unavailable.',
      503,
    ));

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/narration/generate`,
      payload: { engine: 'xai', voice: 'alice' },
    });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'model_unavailable', role: 'writing' });
    expect(ctx.resolveText).toHaveBeenCalledWith(
      'writing',
      expect.objectContaining({ id: projectId }),
    );
    const unchanged = await loadStoryboard(projectPath);
    expect(unchanged!.scenes[0]!.narration!.audio).toBe('narration/existing.mp3');
  });

  it('generate-all ignores dormant xAI speaker settings in monologue mode', async () => {
    const sb = makeSampleStoryboard(projectId);
    sb.scenes[0]!.narration = {
      script: 'First paragraph.\n\nSecond paragraph.',
      mode: 'monologue',
      speakers: {
        A: { engine: 'xai', voice: 'dormant-xai', speed: 1 },
      },
    };
    await saveStoryboard(projectPath, sb);
    ctx.resolveText.mockRejectedValue(new ModelRoutingError(
      'model_unavailable',
      'writing',
      'project',
      'The assigned writing model is unavailable.',
      503,
    ));

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/narration/generate-all`,
      payload: { engine: 'fake', voice: 'alice', selector: 'all' },
    });

    expect(res.statusCode).toBe(200);
    await waitForJobStatus(res.json().jobId, 'completed');
    expect(jobQueue.get(res.json().jobId)?.result).toEqual({ total: 2, completed: 2, failed: 0 });
    expect(ctx.resolveText).not.toHaveBeenCalled();
  });

  it('generate-all ignores xAI assigned only to an unselected dialog chunk', async () => {
    const sb = makeSampleStoryboard(projectId);
    sb.scenes[0]!.narration = {
      script: '[Speaker A] Already rendered.\n[Speaker B] Needs audio.',
      mode: 'dialog',
      speakers: {
        A: { engine: 'xai', voice: 'xai-voice', speed: 1 },
        B: { engine: 'fake', voice: 'bob', speed: 1 },
      },
      chunks: [{
        index: 0,
        text: '[Speaker A] Already rendered.',
        audio: 'narration/existing-a.mp3',
        durationSec: 2,
        speaker: 'A',
      }],
    };
    await saveStoryboard(projectPath, sb);
    ctx.resolveText.mockRejectedValue(new ModelRoutingError(
      'model_unavailable',
      'writing',
      'project',
      'The assigned writing model is unavailable.',
      503,
    ));

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/narration/generate-all`,
      payload: { engine: 'fake', voice: 'alice', selector: 'missing' },
    });

    expect(res.statusCode).toBe(200);
    await waitForJobStatus(res.json().jobId, 'completed');
    expect(jobQueue.get(res.json().jobId)?.result).toEqual({ total: 1, completed: 1, failed: 0 });
    expect(ctx.resolveText).not.toHaveBeenCalled();
  });

  it('generate-all returns the stable writing error for a selected xAI dialog chunk', async () => {
    const sb = makeSampleStoryboard(projectId);
    sb.scenes[0]!.narration = {
      script: '[Speaker A] Generate this with xAI.',
      mode: 'dialog',
      speakers: {
        A: { engine: 'xai', voice: 'xai-voice', speed: 1 },
      },
    };
    await saveStoryboard(projectPath, sb);
    ctx.resolveText.mockRejectedValueOnce(new ModelRoutingError(
      'model_unavailable',
      'writing',
      'project',
      'The assigned writing model is unavailable.',
      503,
    ));

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/narration/generate-all`,
      payload: { engine: 'fake', voice: 'alice', selector: 'all' },
    });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'model_unavailable', role: 'writing' });
    expect(ctx.resolveText).toHaveBeenCalledWith(
      'writing',
      expect.objectContaining({ id: projectId }),
    );
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

  it('routes dialog conversion through writing without resolving general for small sources', async () => {
    await saveStoryboard(projectPath, makeSampleStoryboard(projectId));

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/narration/convert-dialog`,
    });

    expect(res.statusCode).toBe(200);
    expect(ctx.resolveText).toHaveBeenCalledWith(
      'writing',
      expect.objectContaining({ id: projectId }),
    );
    expect(ctx.resolveText).not.toHaveBeenCalledWith('general', expect.anything());
    const updated = await loadStoryboard(projectPath);
    expect(updated!.scenes[0]!.narration).toMatchObject({
      mode: 'dialog',
      dialogScript: 'fake llm response',
    });
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

  it('PUT chunk gap persists gapSec without touching the audio', async () => {
    const sb = makeSampleStoryboard(projectId);
    sb.scenes[0]!.narration = {
      script: 'Hello.\n\nWorld.',
      chunks: [
        { index: 0, text: 'Hello.', audio: 'narration/scene-01-chunk-00.mp3', durationSec: 2 },
        { index: 1, text: 'World.', audio: 'narration/scene-01-chunk-01.mp3', durationSec: 2 },
      ],
    };
    await saveStoryboard(projectPath, sb);

    const res = await ctx.app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/scenes/scene-01/narration/chunks/0/gap`,
      payload: { gapSec: 1.5 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().gapSec).toBe(1.5);

    const updated = await loadStoryboard(projectPath);
    const chunks = updated!.scenes.find((s) => s.id === 'scene-01')!.narration!.chunks!;
    expect(chunks[0]!.gapSec).toBe(1.5);
    expect(chunks[0]!.audio).toBe('narration/scene-01-chunk-00.mp3'); // audio unchanged

    // Clearing with 0 removes the gap.
    await ctx.app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/scenes/scene-01/narration/chunks/0/gap`,
      payload: { gapSec: 0 },
    });
    const cleared = await loadStoryboard(projectPath);
    expect(cleared!.scenes.find((s) => s.id === 'scene-01')!.narration!.chunks![0]!.gapSec).toBeUndefined();
  });

  it('PUT chunk gap stub-creates a chunk for a not-yet-generated index', async () => {
    const sb = makeSampleStoryboard(projectId);
    sb.scenes[0]!.narration = { script: 'A.\n\nB.' }; // no chunks generated yet
    await saveStoryboard(projectPath, sb);

    const res = await ctx.app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/scenes/scene-01/narration/chunks/1/gap`,
      payload: { gapSec: 2 },
    });
    expect(res.statusCode).toBe(200);

    const updated = await loadStoryboard(projectPath);
    const c1 = updated!.scenes.find((s) => s.id === 'scene-01')!.narration!.chunks!.find((c) => c.index === 1);
    expect(c1?.gapSec).toBe(2);
    expect(c1?.text).toBe('B.');
  });

  it('rejects an out-of-range chunk gap', async () => {
    await saveStoryboard(projectPath, makeSampleStoryboard(projectId));
    const res = await ctx.app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/scenes/scene-01/narration/chunks/0/gap`,
      payload: { gapSec: 99 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('invalid_request');
  });
});
