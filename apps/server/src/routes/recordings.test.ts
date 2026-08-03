import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import FormData from 'form-data';
import { ProjectStore } from '../services/project/store.js';
import { saveStoryboard } from '../services/storyboard/index.js';
import { createFakeLlm } from '../services/llm/index.js';
import { createFakeProbe } from '../services/recording/metadata.js';
import { registerRecordingRoutes } from './recordings.js';
import type { Storyboard } from '@vpa/shared';
import { loadStoryboard } from '../services/storyboard/index.js';
import { ingestRecording } from '../services/recording/ingest.js';
import { AgentRecordingDomainError } from '../services/agent-recording/errors.js';
import type { AgentRecordingCoordinator } from '../services/agent-recording/coordinator.js';
import { BULK_UPLOAD_STAGING_PREFIX } from '../services/recording/staged-upload.js';
import { ModelRouter, ModelRoutingError, type ResolvedVideoModel } from '../services/llm/model-router.js';
import { VideoUnderstandingService } from '../services/video-understanding/index.js';
import type { VideoUnderstandingBrief } from '@vpa/shared';
import { projectFiles } from '../services/project/paths.js';

function workspaceRoot(): string {
  return path.resolve(import.meta.dirname, '../../../..');
}

async function buildTestServer(options: {
  bulkUploadLimits?: { fileSizeBytes: number; fileCount: number };
  ingest?: typeof ingestRecording;
  resolveVideo?: ModelRouter['resolveVideo'];
  resolveText?: ModelRouter['resolveText'];
  readBriefStatus?: VideoUnderstandingService['readBriefStatus'];
  ensureBrief?: VideoUnderstandingService['ensureBrief'];
} = {}) {
  const home = await mkdtemp(path.join(tmpdir(), 'vpa-rec-routes-'));
  const projects = await mkdtemp(path.join(tmpdir(), 'vpa-rec-projects-'));
  const store = new ProjectStore({ vpaHome: home, projectsDefault: projects });
  const llm = createFakeLlm();
  const llmComplete = vi.spyOn(llm, 'complete');
  const probe = vi.fn(createFakeProbe());
  const videoModel: ResolvedVideoModel = {
    apiKey: 'private-test-key',
    model: 'gemini-2.5-pro',
    summary: {
      role: 'video-understanding',
      scope: 'global',
      entry_id: 'gemini-video',
      provider: 'gemini',
      model: 'gemini-2.5-pro',
      name: 'Gemini Video',
      capabilities: { text: true, video: true },
      ready: true,
    },
  };
  const makeBrief = (sceneId: string, videoPath: string): VideoUnderstandingBrief => ({
    schema_version: 1,
    prompt_version: 1,
    scene_id: sceneId,
    source: {
      path: videoPath,
      sha256: 'a'.repeat(64),
      duration_sec: 47.2,
      width: 1920,
      height: 1080,
    },
    model: { entry_id: 'gemini-video', provider: 'gemini', model: 'gemini-2.5-pro' },
    created_at: '2026-08-01T12:00:00.000Z',
    visual_summary: 'A browser opens the deployment dashboard and filters unhealthy workloads.',
    segments: [{
      id: 'segment-1',
      start_sec: 0,
      end_sec: 47.2,
      screen_change: 'The web app updates its filtered results.',
      visible_labels: ['Deployment health'],
      on_screen_terms: ['browser'],
    }],
    pacing_cues: [],
    narration_cues: [],
    lower_third_candidates: [],
  });
  const resolveVideo = vi.fn(options.resolveVideo ?? (async () => videoModel));
  const resolveText = vi.fn(options.resolveText ?? (async () => ({
    client: llm,
    summary: {
      role: 'general' as const,
      scope: 'global' as const,
      entry_id: 'fake',
      provider: 'fake' as const,
      model: 'fake',
      name: 'Fake',
      capabilities: { text: true, video: false },
      ready: true,
    },
  })));
  const readBriefStatus = vi.fn(options.readBriefStatus ?? (async () => ({ status: 'missing' as const })));
  const ensureBrief = vi.fn(options.ensureBrief ?? (async (input) => makeBrief(input.sceneId, input.videoPath)));
  const recoverAttachment = vi.fn(async (projectId: string, sceneId: string, sessionId: string, input: { capturedAt: string; uploadedPath: string }) => {
    const project = await store.readProject(projectId);
    return ingestRecording(project.path, sceneId, input.uploadedPath, await probe(input.uploadedPath), {
      source_kind: 'cap-agent', capture_session_id: sessionId, captured_at: input.capturedAt,
    });
  });
  const withManualUploadReservation = vi.fn(async <T>(
    _projectId: string,
    _sceneIds: readonly string[],
    operation: () => Promise<T>,
  ) => operation());

  const app = Fastify();
  await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024, files: 10 } });
  await app.register(async (i) =>
    registerRecordingRoutes(i, {
      store,
      workspaceRoot: workspaceRoot(),
      router: { resolveVideo, resolveText } as unknown as ModelRouter,
      videoUnderstanding: { readBriefStatus, ensureBrief } as unknown as VideoUnderstandingService,
      probe,
      bulkUploadLimits: options.bulkUploadLimits,
      ingest: options.ingest,
      agentRecordingCoordinator: {
        recoverAttachment,
        withManualUploadReservation: withManualUploadReservation as unknown as AgentRecordingCoordinator['withManualUploadReservation'],
      },
    }),
  );
  return {
    app,
    store,
    llm,
    llmComplete,
    home,
    projects,
    probe,
    recoverAttachment,
    withManualUploadReservation,
    resolveVideo,
    resolveText,
    readBriefStatus,
    ensureBrief,
    makeBrief,
  };
}

async function bulkStagingDirectories(): Promise<string[]> {
  return (await readdir(tmpdir()))
    .filter((name) => name.startsWith(BULK_UPLOAD_STAGING_PREFIX))
    .sort();
}

function makeSampleStoryboard(projectId: string, projectName: string): Storyboard {
  return {
    schema_version: 1,
    project: {
      id: projectId,
      name: projectName,
      created: new Date().toISOString(),
      objective: 'test objective',
    },
    scenes: [
      { id: 'scene-01', name: 'Intro', description: 'Intro scene', type: 'desktop' },
      { id: 'scene-02', name: 'Demo', description: 'Demo scene', type: 'terminal' },
    ],
  };
}

async function uploadSceneRecording(
  app: FastifyInstance,
  projectId: string,
  sceneId = 'scene-01',
) {
  const form = new FormData();
  form.append('file', Buffer.from('fake-mp4-data'), {
    filename: `${sceneId}.mp4`,
    contentType: 'video/mp4',
  });
  return app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/scenes/${sceneId}/recording`,
    payload: form.getBuffer(),
    headers: form.getHeaders(),
  });
}

describe('recording routes', () => {
  let ctx: Awaited<ReturnType<typeof buildTestServer>>;
  let projectId: string;
  let projectPath: string;

  beforeEach(async () => {
    ctx = await buildTestServer();
    const project = await ctx.store.create({ name: 'test-proj', objective: 'testing' });
    projectId = project.id;
    projectPath = project.path;
  });

  afterEach(async () => {
    await ctx.app.close();
    await rm(ctx.home, { recursive: true, force: true });
    await rm(ctx.projects, { recursive: true, force: true });
  });

  describe('POST /api/projects/:id/scenes/:sceneId/recording', () => {
    it('uploads a recording for a scene', async () => {
      const sb = makeSampleStoryboard(projectId, 'test-proj');
      await saveStoryboard(projectPath, sb);

      const form = new FormData();
      form.append('file', Buffer.from('fake-mp4-data'), {
        filename: 'scene-01.mp4',
        contentType: 'video/mp4',
      });

      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/scenes/scene-01/recording`,
        payload: form.getBuffer(),
        headers: form.getHeaders(),
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.sceneId).toBe('scene-01');
      expect(body.relativePath).toBe('recordings/scene-01.mp4');
      expect(body.metadata.duration_sec).toBe(47.2);
      expect(body.analysis).toMatchObject({
        status: 'ready',
        briefFreshness: 'generated',
        model: { role: 'video-understanding', provider: 'gemini' },
      });
    });

    it('keeps the recording attached when video understanding is unassigned', async () => {
      await saveStoryboard(projectPath, makeSampleStoryboard(projectId, 'test-proj'));
      ctx.resolveVideo.mockRejectedValueOnce(new ModelRoutingError(
        'model_assignment_missing',
        'video-understanding',
        'global',
        'No model is assigned to the video-understanding role. Choose one in global model settings.',
        422,
      ));

      const res = await uploadSceneRecording(ctx.app, projectId);

      expect(res.statusCode).toBe(201);
      expect(res.json().analysis).toEqual({
        status: 'failed',
        code: 'model_assignment_missing',
        message: 'No model is assigned to the video-understanding role. Choose one in global model settings.',
      });
      const saved = await loadStoryboard(projectPath);
      expect(saved?.scenes[0]?.recording?.source).toBe('recordings/scene-01.mp4');
      await expect(stat(path.join(projectPath, 'recordings', 'scene-01.mp4'))).resolves.toBeDefined();
    });

    it('keeps the local recording and existing metadata when Gemini analysis fails', async () => {
      await saveStoryboard(projectPath, makeSampleStoryboard(projectId, 'test-proj'));
      ctx.ensureBrief.mockRejectedValueOnce(new Error('provider body with private details'));

      const res = await uploadSceneRecording(ctx.app, projectId);

      expect(res.statusCode).toBe(201);
      expect(res.json().analysis).toEqual({
        status: 'failed',
        code: 'video_analysis_failed',
        message: 'Video analysis failed. The recording is saved; try re-analyzing later.',
      });
      const saved = await loadStoryboard(projectPath);
      expect(saved?.scenes[0]).toMatchObject({
        name: 'Intro',
        description: 'Intro scene',
        type: 'desktop',
        recording: { source: 'recordings/scene-01.mp4' },
      });
      await expect(stat(path.join(projectPath, 'recordings', 'scene-01.mp4'))).resolves.toBeDefined();
    });

    it('rejects a manual upload while the scene has a nonterminal Cap session', async () => {
      const sb = makeSampleStoryboard(projectId, 'test-proj');
      await saveStoryboard(projectPath, sb);
      ctx.withManualUploadReservation.mockRejectedValueOnce(
        new AgentRecordingDomainError('CONFLICT', 'Agent recording is active.'),
      );

      const form = new FormData();
      form.append('file', Buffer.from('fake-mp4-data'), {
        filename: 'scene-01.mp4',
        contentType: 'video/mp4',
      });
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/scenes/scene-01/recording`,
        payload: form.getBuffer(),
        headers: form.getHeaders(),
      });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'agent_recording_active' });
      expect((await loadStoryboard(projectPath))?.scenes[0]?.recording).toBeUndefined();
    });

    it('returns 404 when no storyboard exists', async () => {
      const form = new FormData();
      form.append('file', Buffer.from('fake'), { filename: 'test.mp4', contentType: 'video/mp4' });

      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/scenes/scene-01/recording`,
        payload: form.getBuffer(),
        headers: form.getHeaders(),
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('not_found');
    });

    it('returns 404 for non-existent scene', async () => {
      const sb = makeSampleStoryboard(projectId, 'test-proj');
      await saveStoryboard(projectPath, sb);

      const form = new FormData();
      form.append('file', Buffer.from('fake'), { filename: 'test.mp4', contentType: 'video/mp4' });

      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/scenes/no-such-scene/recording`,
        payload: form.getBuffer(),
        headers: form.getHeaders(),
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('scene_not_found');
    });

    it('delegates Cap attachment recovery to the coordinator and saves provenance', async () => {
      const sb = makeSampleStoryboard(projectId, 'test-proj');
      await saveStoryboard(projectPath, sb);
      const sessionId = '11111111-1111-4111-8111-111111111111';

      const form = new FormData();
      form.append('source_kind', 'cap-agent');
      form.append('capture_session_id', sessionId);
      form.append('captured_at', '2026-07-31T12:00:00.000Z');
      form.append('file', Buffer.from('fake-mp4-data'), { filename: 'take.mp4', contentType: 'video/mp4' });
      const res = await ctx.app.inject({ method: 'POST', url: `/api/projects/${projectId}/scenes/scene-01/recording`, payload: form.getBuffer(), headers: form.getHeaders() });

      expect(res.statusCode).toBe(201);
      expect(ctx.recoverAttachment).toHaveBeenCalledWith(projectId, 'scene-01', sessionId, expect.objectContaining({ capturedAt: '2026-07-31T12:00:00.000Z' }));
      const saved = await loadStoryboard(projectPath);
      expect(saved?.scenes[0]?.recording).toMatchObject({ source_kind: 'cap-agent', capture_session_id: sessionId, captured_at: '2026-07-31T12:00:00.000Z' });
    });

    it('rejects troubleshooting Cap provenance while the session still awaits confirmation', async () => {
      const sb = makeSampleStoryboard(projectId, 'test-proj');
      await saveStoryboard(projectPath, sb);
      const sessionId = '22222222-2222-4222-8222-222222222222';
      ctx.recoverAttachment.mockRejectedValueOnce(new Error('not coordinator verified'));

      const form = new FormData();
      form.append('source_kind', 'cap-agent');
      form.append('capture_session_id', sessionId);
      form.append('captured_at', '2026-07-31T12:00:00.000Z');
      form.append('file', Buffer.from('fake-mp4-data'), { filename: 'take.mp4', contentType: 'video/mp4' });
      const res = await ctx.app.inject({ method: 'POST', url: `/api/projects/${projectId}/scenes/scene-01/recording`, payload: form.getBuffer(), headers: form.getHeaders() });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('invalid_capture_session');
      expect((await loadStoryboard(projectPath))?.scenes[0]?.recording).toBeUndefined();
    });
  });

  describe('POST /api/projects/:id/scenes/:sceneId/analyze', () => {
    beforeEach(async () => {
      await saveStoryboard(projectPath, makeSampleStoryboard(projectId, 'test-proj'));
      const upload = await uploadSceneRecording(ctx.app, projectId);
      expect(upload.statusCode).toBe(201);
      ctx.resolveVideo.mockClear();
      ctx.resolveText.mockClear();
      ctx.ensureBrief.mockClear();
      ctx.llmComplete.mockClear();
    });

    it('returns a grounded dry-run proposal derived from the current brief', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/scenes/scene-01/analyze`,
        payload: { groundInVideo: true, dryRun: true },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        sceneId: 'scene-01',
        dryRun: true,
        proposed: {
          name: 'A browser opens the deployment dashboard',
          description: 'A browser opens the deployment dashboard and filters unhealthy workloads.',
          type: 'browser',
        },
        current: { name: 'Intro', description: 'Intro scene', type: 'desktop' },
        mode: 'video',
      });
      expect(ctx.resolveVideo).toHaveBeenCalledOnce();
      expect(ctx.resolveText).not.toHaveBeenCalled();
      expect(ctx.llmComplete).not.toHaveBeenCalled();
      expect((await loadStoryboard(projectPath))?.scenes[0]).toMatchObject({
        name: 'Intro',
        description: 'Intro scene',
        type: 'desktop',
      });
    });

    it('applies validated grounded metadata only when dry-run is disabled', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/scenes/scene-01/analyze`,
        payload: { groundInVideo: true, dryRun: false },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        sceneId: 'scene-01',
        name: 'A browser opens the deployment dashboard',
        description: 'A browser opens the deployment dashboard and filters unhealthy workloads.',
        type: 'browser',
        mode: 'video',
      });
      expect((await loadStoryboard(projectPath))?.scenes[0]).toMatchObject({
        name: 'A browser opens the deployment dashboard',
        description: 'A browser opens the deployment dashboard and filters unhealthy workloads.',
        type: 'browser',
        recording: { source: 'recordings/scene-01.mp4' },
      });
    });

    it('does not call metadata-only analysis or mutate metadata after grounded failure', async () => {
      const privateName = `Provider /private/secret https://provider.invalid/${'x'.repeat(1_000)}`;
      const providerError = new Error('provider failure with private body');
      providerError.name = privateName;
      ctx.ensureBrief.mockRejectedValueOnce(providerError);
      const warn = vi.spyOn(ctx.app.log, 'warn');

      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/scenes/scene-01/analyze`,
        payload: { groundInVideo: true, dryRun: false },
      });

      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({
        error: 'Video analysis failed. The recording is saved; try re-analyzing later.',
        code: 'video_analysis_failed',
      });
      expect(ctx.resolveText).not.toHaveBeenCalled();
      expect(ctx.llmComplete).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        { sceneId: 'scene-01', errorName: 'Error' },
        'Scene re-analysis failed',
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain('/private/secret');
      expect(JSON.stringify(warn.mock.calls)).not.toContain('provider.invalid');
      expect((await loadStoryboard(projectPath))?.scenes[0]).toMatchObject({
        name: 'Intro',
        description: 'Intro scene',
        type: 'desktop',
        recording: { source: 'recordings/scene-01.mp4' },
      });
    });

    it('returns stable routing remediation without falling back for grounded reanalysis', async () => {
      ctx.resolveVideo.mockRejectedValueOnce(new ModelRoutingError(
        'model_capability_mismatch',
        'video-understanding',
        'project',
        'The assigned model cannot handle video-understanding. Choose a compatible model in project model settings.',
        422,
      ));

      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/scenes/scene-01/analyze`,
        payload: { groundInVideo: true, dryRun: true },
      });

      expect(res.statusCode).toBe(422);
      expect(res.json()).toEqual({
        error: 'The assigned model cannot handle video-understanding. Choose a compatible model in project model settings.',
        code: 'model_capability_mismatch',
        role: 'video-understanding',
      });
      expect(ctx.resolveText).not.toHaveBeenCalled();
      expect(ctx.ensureBrief).not.toHaveBeenCalled();
      expect(ctx.llmComplete).not.toHaveBeenCalled();
    });

    it.each(['missing', 'corrupt'] as const)(
      'returns a stable bounded error without mutation when project metadata is %s',
      async (metadataState) => {
        const metadataPath = projectFiles(projectPath).metadata;
        if (metadataState === 'missing') {
          await rm(metadataPath);
        } else {
          await writeFile(metadataPath, 'invalid: [yaml');
        }

        const res = await ctx.app.inject({
          method: 'POST',
          url: `/api/projects/${projectId}/scenes/scene-01/analyze`,
          payload: { groundInVideo: true, dryRun: false },
        });

        expect(res.statusCode).toBe(500);
        expect(res.json()).toEqual({
          error: 'Video analysis failed. The recording is saved; try re-analyzing later.',
          code: 'video_analysis_failed',
        });
        expect(res.body).not.toContain(projectPath);
        expect(ctx.resolveVideo).not.toHaveBeenCalled();
        expect(ctx.resolveText).not.toHaveBeenCalled();
        expect(ctx.ensureBrief).not.toHaveBeenCalled();
        expect(ctx.llmComplete).not.toHaveBeenCalled();
        expect((await loadStoryboard(projectPath))?.scenes[0]).toMatchObject({
          name: 'Intro',
          description: 'Intro scene',
          type: 'desktop',
          recording: { source: 'recordings/scene-01.mp4' },
        });
      },
    );

    it('resolves general independently for explicit text-only reanalysis', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/scenes/scene-01/analyze`,
        payload: { groundInVideo: false, dryRun: true },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ sceneId: 'scene-01', dryRun: true, mode: 'text' });
      expect(ctx.resolveText).toHaveBeenCalledWith(
        'general',
        expect.objectContaining({ id: projectId }),
      );
      expect(ctx.resolveVideo).not.toHaveBeenCalled();
      expect(ctx.ensureBrief).not.toHaveBeenCalled();
      expect(ctx.llmComplete).toHaveBeenCalledOnce();
    });
  });

  describe('POST /api/projects/:id/recordings/bulk', () => {
    it('uploads multiple recordings assigned to scenes in order', async () => {
      const sb = makeSampleStoryboard(projectId, 'test-proj');
      await saveStoryboard(projectPath, sb);
      const stagingBefore = await bulkStagingDirectories();

      const form = new FormData();
      form.append('file1', Buffer.from('mp4-data-1'), { filename: 'rec-01.mp4', contentType: 'video/mp4' });
      form.append('file2', Buffer.from('mp4-data-2'), { filename: 'rec-02.mp4', contentType: 'video/mp4' });

      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/recordings/bulk`,
        payload: form.getBuffer(),
        headers: form.getHeaders(),
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.assignedCount).toBe(2);
      expect(body.results).toHaveLength(2);
      expect(body.results[0].sceneId).toBe('scene-01');
      expect(body.results[1].sceneId).toBe('scene-02');
      expect(ctx.withManualUploadReservation).toHaveBeenCalledWith(
        projectId,
        ['scene-01', 'scene-02'],
        expect.any(Function),
      );
      const probedPaths = ctx.probe.mock.calls.map(([filePath]) => filePath);
      expect(probedPaths).toHaveLength(2);
      expect(probedPaths.every((filePath) => !filePath.startsWith(projectPath))).toBe(true);
      await Promise.all(probedPaths.map((filePath) =>
        expect(stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' })));
      expect(await bulkStagingDirectories()).toEqual(stagingBefore);
    });

    it('returns one conflict without overwriting any scene when a bulk reservation fails', async () => {
      const sb = makeSampleStoryboard(projectId, 'test-proj');
      await saveStoryboard(projectPath, sb);
      const stagingBefore = await bulkStagingDirectories();
      ctx.withManualUploadReservation.mockRejectedValueOnce(
        new AgentRecordingDomainError('CONFLICT', 'Agent recording is active.'),
      );
      const form = new FormData();
      form.append('file1', Buffer.from('mp4-data-1'), { filename: 'rec-01.mp4', contentType: 'video/mp4' });
      form.append('file2', Buffer.from('mp4-data-2'), { filename: 'rec-02.mp4', contentType: 'video/mp4' });

      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/recordings/bulk`,
        payload: form.getBuffer(),
        headers: form.getHeaders(),
      });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'agent_recording_active' });
      expect((await loadStoryboard(projectPath))?.scenes.every((scene) => !scene.recording)).toBe(true);
      expect(await bulkStagingDirectories()).toEqual(stagingBefore);
    });

    it('cleans staged files and leaves the storyboard unchanged when processing fails', async () => {
      const sb = makeSampleStoryboard(projectId, 'test-proj');
      await saveStoryboard(projectPath, sb);
      const stagingBefore = await bulkStagingDirectories();
      ctx.probe.mockRejectedValueOnce(new Error('probe failed'));
      const form = new FormData();
      form.append('file', Buffer.from('mp4-data'), { filename: 'rec.mp4', contentType: 'video/mp4' });

      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/recordings/bulk`,
        payload: form.getBuffer(),
        headers: form.getHeaders(),
      });

      expect(res.statusCode).toBe(500);
      expect((await loadStoryboard(projectPath))?.scenes.every((scene) => !scene.recording)).toBe(true);
      expect(await bulkStagingDirectories()).toEqual(stagingBefore);
    });

    it('cleans staged files and leaves the storyboard unchanged when ingestion fails', async () => {
      await ctx.app.close();
      await rm(ctx.home, { recursive: true, force: true });
      await rm(ctx.projects, { recursive: true, force: true });
      ctx = await buildTestServer({
        ingest: vi.fn(async () => {
          throw new Error('ingest failed');
        }),
      });
      const project = await ctx.store.create({ name: 'ingest-failure-proj', objective: 'testing' });
      projectId = project.id;
      projectPath = project.path;
      await saveStoryboard(projectPath, makeSampleStoryboard(projectId, 'ingest-failure-proj'));
      const stagingBefore = await bulkStagingDirectories();
      const form = new FormData();
      form.append('file', Buffer.from('mp4-data'), { filename: 'rec.mp4', contentType: 'video/mp4' });

      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/recordings/bulk`,
        payload: form.getBuffer(),
        headers: form.getHeaders(),
      });

      expect(res.statusCode).toBe(500);
      expect((await loadStoryboard(projectPath))?.scenes.every((scene) => !scene.recording)).toBe(true);
      expect(await bulkStagingDirectories()).toEqual(stagingBefore);
    });

    it('rejects an over-limit streamed file and cleans its staging directory', async () => {
      await ctx.app.close();
      await rm(ctx.home, { recursive: true, force: true });
      await rm(ctx.projects, { recursive: true, force: true });
      ctx = await buildTestServer({ bulkUploadLimits: { fileSizeBytes: 8, fileCount: 10 } });
      const project = await ctx.store.create({ name: 'bounded-proj', objective: 'testing' });
      projectId = project.id;
      projectPath = project.path;
      await saveStoryboard(projectPath, makeSampleStoryboard(projectId, 'bounded-proj'));
      const stagingBefore = await bulkStagingDirectories();
      const form = new FormData();
      form.append('file', Buffer.from('123456789'), { filename: 'too-large.mp4', contentType: 'video/mp4' });

      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/recordings/bulk`,
        payload: form.getBuffer(),
        headers: form.getHeaders(),
      });

      expect(res.statusCode).toBe(413);
      expect((await loadStoryboard(projectPath))?.scenes.every((scene) => !scene.recording)).toBe(true);
      expect(await bulkStagingDirectories()).toEqual(stagingBefore);
    });

    it('enforces the request file-count limit before project mutation', async () => {
      await ctx.app.close();
      await rm(ctx.home, { recursive: true, force: true });
      await rm(ctx.projects, { recursive: true, force: true });
      ctx = await buildTestServer({ bulkUploadLimits: { fileSizeBytes: 1024, fileCount: 1 } });
      const project = await ctx.store.create({ name: 'counted-proj', objective: 'testing' });
      projectId = project.id;
      projectPath = project.path;
      await saveStoryboard(projectPath, makeSampleStoryboard(projectId, 'counted-proj'));
      const stagingBefore = await bulkStagingDirectories();
      const form = new FormData();
      form.append('one', Buffer.from('one'), { filename: 'one.mp4', contentType: 'video/mp4' });
      form.append('two', Buffer.from('two'), { filename: 'two.mp4', contentType: 'video/mp4' });

      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/recordings/bulk`,
        payload: form.getBuffer(),
        headers: form.getHeaders(),
      });

      expect(res.statusCode).toBe(413);
      expect((await loadStoryboard(projectPath))?.scenes.every((scene) => !scene.recording)).toBe(true);
      expect(await bulkStagingDirectories()).toEqual(stagingBefore);
    });

    it('rejects more uploads than scenes instead of silently discarding a staged file', async () => {
      const sb = makeSampleStoryboard(projectId, 'test-proj');
      await saveStoryboard(projectPath, sb);
      const stagingBefore = await bulkStagingDirectories();
      const form = new FormData();
      form.append('one', Buffer.from('one'), { filename: 'one.mp4', contentType: 'video/mp4' });
      form.append('two', Buffer.from('two'), { filename: 'two.mp4', contentType: 'video/mp4' });
      form.append('three', Buffer.from('three'), { filename: 'three.mp4', contentType: 'video/mp4' });

      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/recordings/bulk`,
        payload: form.getBuffer(),
        headers: form.getHeaders(),
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'invalid_scene_mapping' });
      expect((await loadStoryboard(projectPath))?.scenes.every((scene) => !scene.recording)).toBe(true);
      expect(await bulkStagingDirectories()).toEqual(stagingBefore);
    });

    it('rejects duplicate target scene IDs before project mutation', async () => {
      const sb = makeSampleStoryboard(projectId, 'test-proj');
      sb.scenes[1] = { ...sb.scenes[1]!, id: 'scene-01' };
      await saveStoryboard(projectPath, sb);
      const stagingBefore = await bulkStagingDirectories();
      const form = new FormData();
      form.append('one', Buffer.from('one'), { filename: 'one.mp4', contentType: 'video/mp4' });
      form.append('two', Buffer.from('two'), { filename: 'two.mp4', contentType: 'video/mp4' });

      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/recordings/bulk`,
        payload: form.getBuffer(),
        headers: form.getHeaders(),
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'invalid_scene_mapping' });
      expect((await loadStoryboard(projectPath))?.scenes.every((scene) => !scene.recording)).toBe(true);
      expect(await bulkStagingDirectories()).toEqual(stagingBefore);
    });

    it('returns 404 when no storyboard exists', async () => {
      const form = new FormData();
      form.append('file', Buffer.from('fake'), { filename: 'test.mp4', contentType: 'video/mp4' });

      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/recordings/bulk`,
        payload: form.getBuffer(),
        headers: form.getHeaders(),
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('GET /api/projects/:id/scenes/:sceneId/recording/metadata', () => {
    it('returns 404 when scene has no recording', async () => {
      const sb = makeSampleStoryboard(projectId, 'test-proj');
      await saveStoryboard(projectPath, sb);

      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/scenes/scene-01/recording/metadata`,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('no_recording');
    });

    it('returns 404 for non-existent scene', async () => {
      const sb = makeSampleStoryboard(projectId, 'test-proj');
      await saveStoryboard(projectPath, sb);

      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/scenes/no-such/recording/metadata`,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('scene_not_found');
    });
  });

  describe('POST /api/projects/:id/recordings/generate-storyboard', () => {
    it('generates storyboard from uploaded recordings', async () => {
      const form = new FormData();
      form.append('file1', Buffer.from('mp4-data-1'), { filename: 'intro.mp4', contentType: 'video/mp4' });
      form.append('file2', Buffer.from('mp4-data-2'), { filename: 'demo.mp4', contentType: 'video/mp4' });

      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/recordings/generate-storyboard`,
        payload: form.getBuffer(),
        headers: form.getHeaders(),
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.schema_version).toBe(1);
      expect(body.scenes).toHaveLength(2);
      expect(body.scenes[0].name).toBeTruthy();
      expect(body.scenes[0].recording).toBeDefined();
      expect(body.scenes[0].recording.source).toContain('recordings/');
      expect(body.scenes[1].recording).toBeDefined();
      expect(ctx.resolveText).toHaveBeenCalledWith(
        'general',
        expect.objectContaining({ id: projectId }),
      );
    });

    it('preserves the existing storyboard and bounds provider diagnostics', async () => {
      const existing = makeSampleStoryboard(projectId, 'test-proj');
      await saveStoryboard(projectPath, existing);
      ctx.llmComplete.mockRejectedValueOnce(new Error('private provider response'));
      const form = new FormData();
      form.append('file', Buffer.from('mp4-data'), { filename: 'intro.mp4', contentType: 'video/mp4' });

      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/recordings/generate-storyboard`,
        payload: form.getBuffer(),
        headers: form.getHeaders(),
      });

      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({
        error: 'Storyboard generation failed. Your existing storyboard was not changed.',
        code: 'storyboard_generation_failed',
      });
      expect(JSON.stringify(res.json())).not.toContain('private provider response');
      expect(await loadStoryboard(projectPath)).toEqual(existing);
    });

    it('rolls back the storyboard and owned recording files when injected ingestion fails', async () => {
      await ctx.app.close();
      await rm(ctx.home, { recursive: true, force: true });
      await rm(ctx.projects, { recursive: true, force: true });
      const ingestWithFailure = vi.fn(async (...args: Parameters<typeof ingestRecording>) => {
        const result = await ingestRecording(...args);
        if (args[1] === 'scene-02') throw new Error('private ingestion failure');
        return result;
      });
      ctx = await buildTestServer({ ingest: ingestWithFailure });
      const project = await ctx.store.create({ name: 'ingestion-rollback', objective: 'Preserve existing work' });
      projectId = project.id;
      projectPath = project.path;
      const existing = makeSampleStoryboard(projectId, 'ingestion-rollback');
      existing.scenes[0]!.recording = { source: 'recordings/scene-01.mp4', duration_sec: 10 };
      existing.scenes[1]!.recording = { source: 'recordings/scene-02.mp4', duration_sec: 20 };
      await saveStoryboard(projectPath, existing);
      const recordingsDir = path.join(projectPath, 'recordings');
      await mkdir(recordingsDir, { recursive: true });
      await writeFile(path.join(recordingsDir, 'scene-01.mp4'), 'existing-scene-01');
      await writeFile(path.join(recordingsDir, 'scene-02.mp4'), 'existing-scene-02');
      const form = new FormData();
      form.append('file1', Buffer.from('replacement-01'), { filename: 'one.mp4', contentType: 'video/mp4' });
      form.append('file2', Buffer.from('replacement-02'), { filename: 'two.mp4', contentType: 'video/mp4' });

      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/recordings/generate-storyboard`,
        payload: form.getBuffer(),
        headers: form.getHeaders(),
      });

      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({
        error: 'Storyboard generation failed. Your existing storyboard was not changed.',
        code: 'storyboard_generation_failed',
      });
      expect(ingestWithFailure).toHaveBeenCalledTimes(2);
      expect(await loadStoryboard(projectPath)).toEqual(existing);
      await expect(readFile(path.join(recordingsDir, 'scene-01.mp4'), 'utf8'))
        .resolves.toBe('existing-scene-01');
      await expect(readFile(path.join(recordingsDir, 'scene-02.mp4'), 'utf8'))
        .resolves.toBe('existing-scene-02');
    });

    it('returns a stable general routing error without changing the storyboard', async () => {
      const existing = makeSampleStoryboard(projectId, 'test-proj');
      await saveStoryboard(projectPath, existing);
      ctx.resolveText.mockRejectedValueOnce(new ModelRoutingError(
        'model_assignment_missing',
        'general',
        'project',
        'No general model is assigned.',
        422,
      ));
      const form = new FormData();
      form.append('file', Buffer.from('mp4-data'), { filename: 'intro.mp4', contentType: 'video/mp4' });

      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/recordings/generate-storyboard`,
        payload: form.getBuffer(),
        headers: form.getHeaders(),
      });

      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ code: 'model_assignment_missing', role: 'general' });
      expect(await loadStoryboard(projectPath)).toEqual(existing);
    });

    it('returns 400 when no files uploaded', async () => {
      const form = new FormData();

      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/recordings/generate-storyboard`,
        payload: form.getBuffer(),
        headers: form.getHeaders(),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('no_files');
    });
  });

  describe('POST /api/projects/:id/recordings/propose-split', () => {
    it('uses the project general model for boundary proposals', async () => {
      const form = new FormData();
      form.append('file', Buffer.from('source-video'), { filename: 'source.mp4', contentType: 'video/mp4' });

      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/recordings/propose-split`,
        payload: form.getBuffer(),
        headers: form.getHeaders(),
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().boundaries).toHaveLength(3);
      expect(ctx.resolveText).toHaveBeenCalledWith(
        'general',
        expect.objectContaining({ id: projectId }),
      );
    });

    it('preserves the prior source recording when the provider fails', async () => {
      const recordingsDir = path.join(projectPath, 'recordings');
      const sourcePath = path.join(recordingsDir, '_source.mp4');
      await mkdir(recordingsDir, { recursive: true });
      await writeFile(sourcePath, 'existing-source');
      ctx.llmComplete.mockRejectedValueOnce(new Error('private boundary provider body'));
      const form = new FormData();
      form.append('file', Buffer.from('replacement-source'), { filename: 'source.mp4', contentType: 'video/mp4' });

      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/recordings/propose-split`,
        payload: form.getBuffer(),
        headers: form.getHeaders(),
      });

      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({
        error: 'Recording boundary proposal failed. Your existing source recording was not changed.',
        code: 'boundary_proposal_failed',
      });
      expect(JSON.stringify(res.json())).not.toContain('private boundary provider body');
      expect(await readFile(sourcePath, 'utf8')).toBe('existing-source');
      expect((await readdir(recordingsDir)).some((name) => name.startsWith('._source-'))).toBe(false);
    });
  });
});
