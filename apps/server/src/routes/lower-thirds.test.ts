import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import type { ResolvedModelSummary, Storyboard, VideoUnderstandingBrief } from '@vpa/shared';
import { ProjectStore } from '../services/project/store.js';
import { saveStoryboard, loadStoryboard } from '../services/storyboard/index.js';
import type { LlmClient, LlmCompleteOptions } from '../services/llm/index.js';
import {
  ModelRouter,
  ModelRoutingError,
  type ResolvedTextModel,
  type ResolvedVideoModel,
} from '../services/llm/model-router.js';
import { VideoUnderstandingService } from '../services/video-understanding/index.js';
import { addText } from '../services/project-source-docs/index.js';
import { sha256File } from '../services/recording/metadata.js';
import { registerLowerThirdsRoutes } from './lower-thirds.js';

function workspaceRoot(): string {
  return path.resolve(import.meta.dirname, '../../../..');
}

function modelSummary(role: ResolvedModelSummary['role']): ResolvedModelSummary {
  return {
    role,
    scope: 'global',
    entry_id: role === 'video-understanding' ? 'gemini-video' : 'codex-writer',
    provider: role === 'video-understanding' ? 'gemini' : 'codex-cli',
    model: role === 'video-understanding' ? 'gemini-2.5-pro' : 'default',
    name: role === 'video-understanding' ? 'Gemini 2.5 Pro' : 'Codex',
    capabilities: {
      text: role !== 'video-understanding',
      video: role === 'video-understanding',
    },
    ready: true,
  };
}

function makeBrief(videoPath: string, sha256 = 'a'.repeat(64)): VideoUnderstandingBrief {
  return {
    schema_version: 1,
    prompt_version: 1,
    scene_id: 'scene-01',
    source: {
      path: videoPath,
      sha256,
      duration_sec: 30,
      width: 1920,
      height: 1080,
    },
    model: {
      entry_id: 'gemini-video',
      provider: 'gemini',
      model: 'gemini-2.5-pro',
    },
    created_at: '2026-08-01T12:00:00.000Z',
    visual_summary: 'The workspace opens and model routing is configured.',
    segments: [
      {
        id: 'segment-001',
        start_sec: 0,
        end_sec: 12,
        screen_change: 'The workspace opens.',
        visible_labels: ['Projects'],
        on_screen_terms: ['Workspace'],
      },
      {
        id: 'segment-002',
        start_sec: 12,
        end_sec: 30,
        screen_change: 'The AI models section appears.',
        visible_labels: ['AI models'],
        on_screen_terms: ['Writing'],
      },
    ],
    pacing_cues: [],
    narration_cues: [],
    lower_third_candidates: [
      { segment_id: 'segment-002', reason: 'Explain specialist roles.' },
    ],
  };
}

interface BuildOptions {
  writer?: LlmClient;
  resolveText?: (role: 'writing' | 'general') => Promise<ResolvedTextModel>;
  resolveVideo?: () => Promise<ResolvedVideoModel>;
  readBriefStatus?: VideoUnderstandingService['readBriefStatus'];
  ensureBrief?: VideoUnderstandingService['ensureBrief'];
  fingerprintRecording?: (path: string) => Promise<string>;
  persistStoryboard?: typeof saveStoryboard;
  removeArtifact?: (path: string) => Promise<void>;
}

async function buildTestServer(options: BuildOptions = {}) {
  const home = await mkdtemp(path.join(tmpdir(), 'vpa-lt-routes-'));
  const projects = await mkdtemp(path.join(tmpdir(), 'vpa-lt-projects-'));
  const store = new ProjectStore({ vpaHome: home, projectsDefault: projects });
  const writerComplete = vi.fn(async (input: LlmCompleteOptions) => ({
    text: input.userPrompt.includes('Return only segment IDs')
      ? JSON.stringify([
          {
            segment_id: 'segment-002',
            title: 'Model routing',
            subtitle: 'One specialist per task',
            style: 'frosted',
          },
        ])
      : JSON.stringify([
          {
            title: 'Scene intro',
            subtitle: 'Text-only recommendation',
            style: 'minimal',
            in_sec: 1,
            out_sec: 5,
          },
        ]),
  }));
  const writer = options.writer ?? { complete: writerComplete };
  const resolveText = vi.fn(options.resolveText ?? (async () => ({
    client: writer,
    summary: modelSummary('writing'),
  })));
  const videoModel: ResolvedVideoModel = {
    apiKey: 'private-gemini-key',
    model: 'gemini-2.5-pro',
    summary: modelSummary('video-understanding') as ResolvedVideoModel['summary'],
  };
  const resolveVideo = vi.fn(options.resolveVideo ?? (async () => videoModel));
  const readBriefStatus = vi.fn(options.readBriefStatus ?? (async () => ({ status: 'missing' as const })));
  const ensureBrief = vi.fn(options.ensureBrief ?? (async (input: { videoPath: string }) => (
    makeBrief(input.videoPath)
  )));
  const app = Fastify();
  await app.register(async (instance) => registerLowerThirdsRoutes(instance, {
    store,
    workspaceRoot: workspaceRoot(),
    router: { resolveText, resolveVideo } as unknown as ModelRouter,
    videoUnderstanding: { readBriefStatus, ensureBrief } as unknown as VideoUnderstandingService,
    fingerprintRecording: options.fingerprintRecording ?? (async () => 'a'.repeat(64)),
    persistStoryboard: options.persistStoryboard,
    removeArtifact: options.removeArtifact,
  }));
  return {
    app,
    store,
    home,
    projects,
    writer,
    writerComplete,
    resolveText,
    resolveVideo,
    readBriefStatus,
    ensureBrief,
  };
}

function makeSampleStoryboard(projectId: string): Storyboard {
  return {
    schema_version: 1,
    project: {
      id: projectId,
      name: 'test-proj',
      created: new Date().toISOString(),
      objective: 'Demo LT',
    },
    scenes: [
      { id: 'scene-01', name: 'Intro', description: 'Introduction to the demo', type: 'desktop' },
      { id: 'scene-02', name: 'Setup', description: 'Setting up', type: 'terminal' },
    ],
  };
}

describe('lower-thirds routes', () => {
  let ctx: Awaited<ReturnType<typeof buildTestServer>>;
  let projectId: string;
  let projectPath: string;

  beforeEach(async () => {
    ctx = await buildTestServer();
    const project = await ctx.store.create({ name: 'test-proj', objective: 'Demo LT' });
    projectId = project.id;
    projectPath = project.path;
  });

  afterEach(async () => {
    await ctx.app.close();
    await rm(ctx.home, { recursive: true, force: true });
    await rm(ctx.projects, { recursive: true, force: true });
  });

  it('GET returns empty array when no lower thirds exist', async () => {
    await saveStoryboard(projectPath, makeSampleStoryboard(projectId));

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/scenes/scene-01/lower-thirds`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sceneId: 'scene-01', lowerThirds: [] });
  });

  it('text-only recommendation resolves writing only and returns its routing summary', async () => {
    await saveStoryboard(projectPath, makeSampleStoryboard(projectId));

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/lower-thirds/recommend`,
      payload: { groundInVideo: false },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      sceneId: 'scene-01',
      mode: 'text',
      routing: { writing: modelSummary('writing') },
      lowerThirds: [{ title: 'Scene intro', in_sec: 1, out_sec: 5 }],
    });
    expect(ctx.resolveText).toHaveBeenCalledWith('writing', expect.objectContaining({ id: projectId }));
    expect(ctx.resolveVideo).not.toHaveBeenCalled();
    expect(ctx.readBriefStatus).not.toHaveBeenCalled();
    expect(ctx.ensureBrief).not.toHaveBeenCalled();
    expect((await loadStoryboard(projectPath))!.scenes[0]!.lower_thirds).toEqual(res.json().lowerThirds);
  });

  it('stages a video brief before writing and persists only validated segment times', async () => {
    const storyboard = makeSampleStoryboard(projectId);
    storyboard.scenes[0]!.recording = { source: 'recordings/scene-01.mp4', duration_sec: 30 };
    await saveStoryboard(projectPath, storyboard);
    const videoPath = path.join(projectPath, 'recordings/scene-01.mp4');

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/lower-thirds/recommend`,
      payload: { groundInVideo: true },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      sceneId: 'scene-01',
      mode: 'video',
      routing: {
        videoUnderstanding: modelSummary('video-understanding'),
        writing: modelSummary('writing'),
      },
      briefFreshness: 'generated',
      lowerThirds: [{
        title: 'Model routing',
        subtitle: 'One specialist per task',
        style: 'frosted',
        in_sec: 12,
        out_sec: 18,
      }],
    });
    expect(ctx.resolveVideo).toHaveBeenCalledTimes(1);
    expect(ctx.resolveText).toHaveBeenCalledWith('writing', expect.objectContaining({ id: projectId }));
    expect(ctx.readBriefStatus).toHaveBeenCalledTimes(1);
    expect(ctx.ensureBrief).toHaveBeenCalledTimes(1);
    const writerPrompt = ctx.writerComplete.mock.calls[0]![0].userPrompt;
    expect(writerPrompt).not.toContain(videoPath);
    expect(writerPrompt).not.toContain('generativelanguage.googleapis.com');
    expect((await loadStoryboard(projectPath))!.scenes[0]!.lower_thirds).toEqual(res.json().lowerThirds);
  });

  it('reports a reused brief without changing the routed stages', async () => {
    await ctx.app.close();
    await rm(ctx.home, { recursive: true, force: true });
    await rm(ctx.projects, { recursive: true, force: true });
    ctx = await buildTestServer({
      readBriefStatus: async (input) => ({ status: 'fresh', brief: makeBrief(input.videoPath) }),
    });
    const project = await ctx.store.create({ name: 'reuse-project', objective: 'Reuse timing' });
    projectId = project.id;
    projectPath = project.path;
    const storyboard = makeSampleStoryboard(projectId);
    storyboard.scenes[0]!.recording = { source: 'recordings/scene-01.mp4', duration_sec: 30 };
    await saveStoryboard(projectPath, storyboard);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/lower-thirds/recommend`,
      payload: { groundInVideo: true },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().briefFreshness).toBe('reused');
  });

  it('does not call the writer or replace existing lower thirds when Gemini fails', async () => {
    const existing = makeSampleStoryboard(projectId);
    existing.scenes[0]!.recording = { source: 'recordings/scene-01.mp4', duration_sec: 30 };
    existing.scenes[0]!.lower_thirds = [
      { title: 'Keep me', style: 'solid', in_sec: 2, out_sec: 6 },
    ];
    await saveStoryboard(projectPath, existing);
    ctx.ensureBrief.mockRejectedValueOnce(new Error('private provider response'));

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/lower-thirds/recommend`,
      payload: { groundInVideo: true },
    });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      error: 'Video-grounded lower-third recommendation failed. Your existing lower thirds were not changed.',
      code: 'video_lower_thirds_failed',
    });
    expect(ctx.writerComplete).not.toHaveBeenCalled();
    expect((await loadStoryboard(projectPath))!.scenes[0]!.lower_thirds).toEqual(existing.scenes[0]!.lower_thirds);
  });

  it('preserves existing lower thirds when the writer fails after brief generation', async () => {
    await ctx.app.close();
    await rm(ctx.home, { recursive: true, force: true });
    await rm(ctx.projects, { recursive: true, force: true });
    const complete = vi.fn(async () => {
      throw new Error('private writer response');
    });
    ctx = await buildTestServer({ writer: { complete } });
    const project = await ctx.store.create({ name: 'writer-failure-project', objective: 'Preserve lower thirds' });
    projectId = project.id;
    projectPath = project.path;
    const existing = makeSampleStoryboard(projectId);
    existing.scenes[0]!.recording = { source: 'recordings/scene-01.mp4', duration_sec: 30 };
    existing.scenes[0]!.lower_thirds = [
      { title: 'Keep me', style: 'solid', in_sec: 2, out_sec: 6 },
    ];
    existing.scenes[0]!.overlay_render = 'overlays/existing.mp4';
    await saveStoryboard(projectPath, existing);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/lower-thirds/recommend`,
      payload: { groundInVideo: true },
    });

    expect(res.statusCode).toBe(500);
    expect(res.json().error).not.toContain('private writer response');
    expect(complete).toHaveBeenCalledTimes(1);
    expect((await loadStoryboard(projectPath))!.scenes[0]).toMatchObject({
      lower_thirds: existing.scenes[0]!.lower_thirds,
      overlay_render: 'overlays/existing.mp4',
    });
  });

  it('returns a stable routing error before Gemini work and does not fall back', async () => {
    ctx.resolveText.mockRejectedValueOnce(new ModelRoutingError(
      'model_assignment_missing',
      'writing',
      'global',
      'No model is assigned to the writing role. Choose one in global model settings.',
      422,
    ));
    const existing = makeSampleStoryboard(projectId);
    existing.scenes[0]!.recording = { source: 'recordings/scene-01.mp4', duration_sec: 30 };
    existing.scenes[0]!.lower_thirds = [
      { title: 'Keep me', style: 'solid', in_sec: 2, out_sec: 6 },
    ];
    await saveStoryboard(projectPath, existing);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/lower-thirds/recommend`,
      payload: { groundInVideo: true },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'model_assignment_missing', role: 'writing' });
    expect(ctx.ensureBrief).not.toHaveBeenCalled();
    expect(ctx.writerComplete).not.toHaveBeenCalled();
    expect((await loadStoryboard(projectPath))!.scenes[0]!.lower_thirds).toEqual(existing.scenes[0]!.lower_thirds);
  });

  it('rejects explicit grounding without a recording instead of coercing to text mode', async () => {
    const existing = makeSampleStoryboard(projectId);
    existing.scenes[0]!.lower_thirds = [
      { title: 'Keep me', style: 'solid', in_sec: 2, out_sec: 6 },
    ];
    await saveStoryboard(projectPath, existing);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/lower-thirds/recommend`,
      payload: { groundInVideo: true },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: 'Scene has no recording. Upload a recording first.',
      code: 'no_recording',
    });
    expect(ctx.resolveVideo).not.toHaveBeenCalled();
    expect(ctx.resolveText).not.toHaveBeenCalled();
    expect((await loadStoryboard(projectPath))!.scenes[0]!.lower_thirds).toEqual(existing.scenes[0]!.lower_thirds);
  });

  it.each(['true', 1, null])(
    'rejects malformed groundInVideo value %j before routing or persistence',
    async (groundInVideo) => {
      const existing = makeSampleStoryboard(projectId);
      existing.scenes[0]!.lower_thirds = [
        { title: 'Keep me', style: 'solid', in_sec: 2, out_sec: 6 },
      ];
      await saveStoryboard(projectPath, existing);

      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/scenes/scene-01/lower-thirds/recommend`,
        payload: { groundInVideo },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: 'groundInVideo must be a boolean when provided.',
        code: 'invalid_request',
      });
      expect(ctx.resolveVideo).not.toHaveBeenCalled();
      expect(ctx.resolveText).not.toHaveBeenCalled();
      expect((await loadStoryboard(projectPath))!.scenes[0]!.lower_thirds)
        .toEqual(existing.scenes[0]!.lower_thirds);
    },
  );

  it.each([false, true])(
    'aborts %s-mode recommendation when oversized source summarization fails',
    async (groundInVideo) => {
      await ctx.app.close();
      await rm(ctx.home, { recursive: true, force: true });
      await rm(ctx.projects, { recursive: true, force: true });
      const complete = vi.fn(async () => {
        throw new Error('private source summarizer failure');
      });
      ctx = await buildTestServer({ writer: { complete } });
      const project = await ctx.store.create({
        name: `summary-failure-${groundInVideo}`,
        objective: 'Preserve lower thirds',
      });
      projectId = project.id;
      projectPath = project.path;
      const existing = makeSampleStoryboard(projectId);
      if (groundInVideo) {
        existing.scenes[0]!.recording = { source: 'recordings/scene-01.mp4', duration_sec: 30 };
      }
      existing.scenes[0]!.lower_thirds = [
        { title: 'Keep me', style: 'solid', in_sec: 2, out_sec: 6 },
      ];
      existing.scenes[0]!.overlay_render = 'overlays/existing.mp4';
      await saveStoryboard(projectPath, existing);
      await addText(projectPath, 'source '.repeat(5_000), 'oversized-source');

      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/scenes/scene-01/lower-thirds/recommend`,
        payload: { groundInVideo },
      });

      expect(res.statusCode).toBe(500);
      expect(res.json().error).not.toContain('private source summarizer failure');
      expect(complete).toHaveBeenCalledTimes(1);
      expect((await loadStoryboard(projectPath))!.scenes[0]).toMatchObject({
        lower_thirds: existing.scenes[0]!.lower_thirds,
        overlay_render: 'overlays/existing.mp4',
      });
    },
  );

  it('rejects a same-path recording replacement before grounded persistence', async () => {
    await ctx.app.close();
    await rm(ctx.home, { recursive: true, force: true });
    await rm(ctx.projects, { recursive: true, force: true });
    const originalBytes = Buffer.from('original recording bytes');
    const originalSha256 = createHash('sha256').update(originalBytes).digest('hex');
    let recordingPath = '';
    const complete = vi.fn(async () => {
      await writeFile(recordingPath, 'replacement recording bytes');
      return {
        text: JSON.stringify([{
          segment_id: 'segment-002',
          title: 'Model routing',
          subtitle: 'One specialist per task',
          style: 'frosted',
        }]),
      };
    });
    ctx = await buildTestServer({
      writer: { complete },
      ensureBrief: async (input) => makeBrief(input.videoPath, originalSha256),
      fingerprintRecording: sha256File,
    });
    const project = await ctx.store.create({ name: 'replacement-project', objective: 'Keep timing grounded' });
    projectId = project.id;
    projectPath = project.path;
    recordingPath = path.join(projectPath, 'recordings/scene-01.mp4');
    await mkdir(path.dirname(recordingPath), { recursive: true });
    await writeFile(recordingPath, originalBytes);
    const existing = makeSampleStoryboard(projectId);
    existing.scenes[0]!.recording = { source: 'recordings/scene-01.mp4', duration_sec: 30 };
    existing.scenes[0]!.lower_thirds = [
      { title: 'Keep me', style: 'solid', in_sec: 2, out_sec: 6 },
    ];
    existing.scenes[0]!.overlay_render = 'overlays/existing.mp4';
    await saveStoryboard(projectPath, existing);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/lower-thirds/recommend`,
      payload: { groundInVideo: true },
    });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      error: 'Lower-third recommendation failed. Your existing lower thirds were not changed.',
      code: 'lower_thirds_generation_failed',
    });
    expect((await loadStoryboard(projectPath))!.scenes[0]).toMatchObject({
      recording: existing.scenes[0]!.recording,
      lower_thirds: existing.scenes[0]!.lower_thirds,
      overlay_render: 'overlays/existing.mp4',
    });
  });

  it('keeps the previous storyboard and cache files when persistence fails', async () => {
    await ctx.app.close();
    await rm(ctx.home, { recursive: true, force: true });
    await rm(ctx.projects, { recursive: true, force: true });
    ctx = await buildTestServer({
      persistStoryboard: async () => { throw new Error('private save failure'); },
    });
    const project = await ctx.store.create({ name: 'save-failure-project', objective: 'Keep durable state' });
    projectId = project.id;
    projectPath = project.path;
    const existing = makeSampleStoryboard(projectId);
    existing.scenes[0]!.lower_thirds = [
      { title: 'Keep me', style: 'solid', in_sec: 2, out_sec: 6 },
    ];
    existing.scenes[0]!.overlay_render = 'overlays/existing.mp4';
    existing.scenes[0]!.frame_render = 'frames/existing.mp4';
    const overlayPath = path.join(projectPath, existing.scenes[0]!.overlay_render);
    const framePath = path.join(projectPath, existing.scenes[0]!.frame_render);
    await mkdir(path.dirname(overlayPath), { recursive: true });
    await mkdir(path.dirname(framePath), { recursive: true });
    await writeFile(overlayPath, 'overlay');
    await writeFile(framePath, 'frame');
    await saveStoryboard(projectPath, existing);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/lower-thirds/recommend`,
      payload: { groundInVideo: false },
    });

    expect(res.statusCode).toBe(500);
    expect((await loadStoryboard(projectPath))!.scenes[0]).toMatchObject({
      lower_thirds: existing.scenes[0]!.lower_thirds,
      overlay_render: existing.scenes[0]!.overlay_render,
      frame_render: existing.scenes[0]!.frame_render,
    });
    await expect(readFile(overlayPath, 'utf8')).resolves.toBe('overlay');
    await expect(readFile(framePath, 'utf8')).resolves.toBe('frame');
  });

  it('keeps a successful save when best-effort cache cleanup fails', async () => {
    await ctx.app.close();
    await rm(ctx.home, { recursive: true, force: true });
    await rm(ctx.projects, { recursive: true, force: true });
    const removeArtifact = vi.fn(async () => { throw new Error('private unlink failure'); });
    ctx = await buildTestServer({ removeArtifact });
    const project = await ctx.store.create({ name: 'cleanup-failure-project', objective: 'Save before cleanup' });
    projectId = project.id;
    projectPath = project.path;
    const existing = makeSampleStoryboard(projectId);
    existing.scenes[0]!.overlay_render = 'overlays/existing.mp4';
    existing.scenes[0]!.frame_render = 'frames/existing.mp4';
    const overlayPath = path.join(projectPath, existing.scenes[0]!.overlay_render);
    const framePath = path.join(projectPath, existing.scenes[0]!.frame_render);
    await mkdir(path.dirname(overlayPath), { recursive: true });
    await mkdir(path.dirname(framePath), { recursive: true });
    await writeFile(overlayPath, 'overlay');
    await writeFile(framePath, 'frame');
    await saveStoryboard(projectPath, existing);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/lower-thirds/recommend`,
      payload: { groundInVideo: false },
    });

    expect(res.statusCode).toBe(200);
    const savedScene = (await loadStoryboard(projectPath))!.scenes[0]!;
    expect(savedScene.lower_thirds).toEqual(res.json().lowerThirds);
    expect(savedScene).not.toHaveProperty('overlay_render');
    expect(savedScene).not.toHaveProperty('frame_render');
    expect(removeArtifact).toHaveBeenCalledTimes(2);
    await expect(access(overlayPath)).resolves.toBeUndefined();
    await expect(access(framePath)).resolves.toBeUndefined();
  });

  it('PUT saves edited lower thirds', async () => {
    await saveStoryboard(projectPath, makeSampleStoryboard(projectId));
    const lowerThirds = [
      { title: 'Custom Title', subtitle: 'Custom Sub', style: 'solid' as const, in_sec: 2, out_sec: 7 },
    ];

    const res = await ctx.app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/scenes/scene-01/lower-thirds`,
      payload: { lowerThirds },
    });

    expect(res.statusCode).toBe(200);
    expect((await loadStoryboard(projectPath))!.scenes[0]!.lower_thirds).toEqual(lowerThirds);
  });

  it('PUT returns 400 without a lowerThirds array', async () => {
    await saveStoryboard(projectPath, makeSampleStoryboard(projectId));
    const res = await ctx.app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/scenes/scene-01/lower-thirds`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 for a nonexistent scene or storyboard', async () => {
    await saveStoryboard(projectPath, makeSampleStoryboard(projectId));
    const missingScene = await ctx.app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/scenes/no-such/lower-thirds`,
    });
    expect(missingScene.statusCode).toBe(404);
    expect(missingScene.json().code).toBe('scene_not_found');

    const project = await ctx.store.create({ name: 'empty-project', objective: 'No storyboard' });
    const missingStoryboard = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/scenes/scene-01/lower-thirds/recommend`,
    });
    expect(missingStoryboard.statusCode).toBe(404);
  });
});
