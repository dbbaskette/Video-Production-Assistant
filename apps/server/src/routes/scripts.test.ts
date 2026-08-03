import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { ProjectStore } from '../services/project/store.js';
import { saveStoryboard, loadStoryboard } from '../services/storyboard/index.js';
import type { LlmClient, LlmCompleteOptions } from '../services/llm/index.js';
import {
  ModelRoutingError,
  type ModelRouter,
  type ResolvedTextModel,
  type ResolvedVideoModel,
} from '../services/llm/model-router.js';
import { VideoUnderstandingService } from '../services/video-understanding/index.js';
import type { VideoUnderstandingBrief } from '@vpa/shared';
import { addText } from '../services/project-source-docs/index.js';
import { REFERENCE_BUDGET_CHARS } from '../services/project-source-docs/context.js';
import { registerScriptRoutes } from './scripts.js';
import type { Storyboard } from '@vpa/shared';
import type { AgentRecordingCoordinator } from '../services/agent-recording/coordinator.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function recordingReservation() {
  const held = new Set<string>();
  return vi.fn(async <T>(
    projectId: string,
    sceneIds: readonly string[],
    operation: () => Promise<T>,
  ): Promise<T> => {
    const keys = sceneIds.map((sceneId) => `${projectId}\0${sceneId}`);
    if (keys.some((key) => held.has(key))) throw new Error('Scene recording is reserved.');
    for (const key of keys) held.add(key);
    try {
      return await operation();
    } finally {
      for (const key of keys) held.delete(key);
    }
  }) as unknown as AgentRecordingCoordinator['withManualUploadReservation'];
}

function workspaceRoot(): string {
  return path.resolve(import.meta.dirname, '../../../..');
}

const SCRIPT = 'A fresh narration grounded in the assigned model.';
const DIALOG = '[Speaker A] A fresh dialog.\n\n[Speaker B] Grounded in the same facts.';

function modelSummary(role: 'video-understanding' | 'writing' | 'general') {
  return {
    role,
    scope: 'global' as const,
    entry_id: `${role}-model`,
    provider: role === 'video-understanding' ? 'gemini' as const : 'fake' as const,
    model: `${role}-v1`,
    name: `${role} model`,
    capabilities: { text: true, video: role === 'video-understanding' },
    ready: true as const,
  };
}

function makeBrief(videoPath = '/project/recordings/scene-01.mp4'): VideoUnderstandingBrief {
  return {
    schema_version: 1,
    prompt_version: 1,
    scene_id: 'scene-01',
    source: {
      path: videoPath,
      sha256: 'b'.repeat(64),
      duration_sec: 30,
      width: 1920,
      height: 1080,
    },
    model: {
      entry_id: 'video-understanding-model',
      provider: 'gemini',
      model: 'video-understanding-v1',
    },
    created_at: '2026-08-01T12:00:00.000Z',
    visual_summary: 'The dashboard opens before a project is created.',
    segments: [{
      id: 'segment-001',
      start_sec: 0,
      end_sec: 30,
      screen_change: 'The user creates a project.',
      visible_labels: ['Create project'],
      on_screen_terms: ['Workspace'],
    }],
    pacing_cues: [{ segment_id: 'segment-001', cue: 'Pause for the dashboard.' }],
    narration_cues: [{ segment_id: 'segment-001', cue: 'Explain the project purpose.' }],
    lower_third_candidates: [],
  };
}

interface TestServerOptions {
  writer?: LlmClient;
  general?: LlmClient;
  resolveText?: ModelRouter['resolveText'];
  resolveVideo?: ModelRouter['resolveVideo'];
  videoUnderstanding?: Pick<VideoUnderstandingService, 'readBriefStatus' | 'ensureBrief'>;
  withRecordingReservation?: AgentRecordingCoordinator['withManualUploadReservation'];
  fingerprintRecording?: (path: string) => Promise<string>;
}

async function buildTestServer(options: TestServerOptions = {}) {
  const home = await mkdtemp(path.join(tmpdir(), 'vpa-script-routes-'));
  const projects = await mkdtemp(path.join(tmpdir(), 'vpa-script-projects-'));
  const store = new ProjectStore({ vpaHome: home, projectsDefault: projects });
  const writer = options.writer ?? {
    complete: vi.fn(async (input: LlmCompleteOptions) => ({
      text: input.systemPrompt.includes('script adapter') ? DIALOG : SCRIPT,
    })),
  };
  const general = options.general ?? {
    complete: vi.fn(async () => ({ text: 'A bounded factual source summary.' })),
  };
  const resolvedWriter: ResolvedTextModel = {
    client: writer,
    summary: modelSummary('writing'),
  };
  const resolvedGeneral: ResolvedTextModel = {
    client: general,
    summary: modelSummary('general'),
  };
  const videoModel: ResolvedVideoModel = {
    apiKey: 'private-video-key',
    model: 'video-understanding-v1',
    summary: { ...modelSummary('video-understanding'), provider: 'gemini' },
  };
  const resolveText = vi.fn(options.resolveText ?? (async (role: 'writing' | 'general') => (
    role === 'writing' ? resolvedWriter : resolvedGeneral
  )));
  const resolveVideo = vi.fn(options.resolveVideo ?? (async () => videoModel));
  const readBriefStatus = vi.fn(async () => ({ status: 'missing' as const }));
  const ensureBrief = vi.fn(async (input: { videoPath: string }) => makeBrief(input.videoPath));
  const videoUnderstanding = options.videoUnderstanding ?? {
    readBriefStatus,
    ensureBrief,
  };
  const withRecordingReservation = options.withRecordingReservation ?? recordingReservation();
  const fingerprintRecording = options.fingerprintRecording ?? (async () => 'b'.repeat(64));
  const writerComplete = vi.mocked(writer.complete);

  const app = Fastify();
  await app.register(async (i) =>
    registerScriptRoutes(i, {
      store,
      workspaceRoot: workspaceRoot(),
      router: { resolveText, resolveVideo } as unknown as ModelRouter,
      videoUnderstanding: videoUnderstanding as VideoUnderstandingService,
      agentRecordingCoordinator: { withManualUploadReservation: withRecordingReservation },
      fingerprintRecording,
    }),
  );
  return {
    app,
    store,
    home,
    projects,
    writer,
    writerComplete,
    general,
    resolveText,
    resolveVideo,
    readBriefStatus,
    ensureBrief,
    videoUnderstanding,
    videoModel,
    withRecordingReservation,
    fingerprintRecording,
  };
}

function makeSampleStoryboard(projectId: string): Storyboard {
  return {
    schema_version: 1,
    project: {
      id: projectId,
      name: 'test-proj',
      created: new Date().toISOString(),
      objective: 'Demo MCP setup',
    },
    scenes: [
      { id: 'scene-01', name: 'Intro', description: 'Introduction to the demo', type: 'desktop' },
      { id: 'scene-02', name: 'Setup', description: 'Setting up the environment', type: 'terminal' },
    ],
  };
}

describe('script routes', () => {
  let ctx: Awaited<ReturnType<typeof buildTestServer>>;
  let projectId: string;
  let projectPath: string;

  beforeEach(async () => {
    ctx = await buildTestServer();
    const project = await ctx.store.create({ name: 'test-proj', objective: 'Demo MCP setup' });
    projectId = project.id;
    projectPath = project.path;
  });

  afterEach(async () => {
    await ctx.app.close();
    await rm(ctx.home, { recursive: true, force: true });
    await rm(ctx.projects, { recursive: true, force: true });
  });

  it('GET script returns null when no script exists', async () => {
    const sb = makeSampleStoryboard(projectId);
    await saveStoryboard(projectPath, sb);

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/scenes/scene-01/script`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sceneId).toBe('scene-01');
    expect(body.script).toBeNull();
  });

  it('rejects explicit video grounding without a recording and preserves existing scripts', async () => {
    const sb = makeSampleStoryboard(projectId);
    sb.scenes[0]!.narration = {
      script: 'Existing script.',
      monologueScript: 'Existing script.',
      dialogScript: '[Speaker A] Existing dialog.',
    };
    await saveStoryboard(projectPath, sb);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/script/generate`,
      payload: { groundInVideo: true },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: 'Scene has no recording. Upload a recording first.',
      code: 'no_recording',
    });
    expect(ctx.resolveVideo).not.toHaveBeenCalled();
    expect(ctx.resolveText).not.toHaveBeenCalled();
    expect(ctx.readBriefStatus).not.toHaveBeenCalled();
    expect(ctx.ensureBrief).not.toHaveBeenCalled();
    expect(ctx.writer.complete).not.toHaveBeenCalled();
    expect(ctx.general.complete).not.toHaveBeenCalled();
    expect((await loadStoryboard(projectPath))!.scenes[0]!.narration).toEqual(
      sb.scenes[0]!.narration,
    );
  });

  it('fails bounded without writing when a referenced recording is missing on disk', async () => {
    const realVideoUnderstanding = new VideoUnderstandingService({
      workspaceRoot: workspaceRoot(),
      warn: vi.fn(),
      snapshotVideo: async (sourcePath) => ({ path: sourcePath, cleanup: async () => {} }),
    });
    await ctx.app.close();
    await rm(ctx.home, { recursive: true, force: true });
    await rm(ctx.projects, { recursive: true, force: true });
    ctx = await buildTestServer({
      videoUnderstanding: realVideoUnderstanding,
      fingerprintRecording: async () => 'c'.repeat(64),
    });
    const project = await ctx.store.create({ name: 'missing-recording-project', objective: 'Preserve scripts' });
    projectId = project.id;
    projectPath = project.path;
    const sb = makeSampleStoryboard(projectId);
    sb.scenes[0]!.recording = {
      source: 'recordings/missing-scene-01.mp4',
      duration_sec: 30,
    };
    sb.scenes[0]!.narration = {
      script: 'Existing script.',
      monologueScript: 'Existing script.',
      dialogScript: '[Speaker A] Existing dialog.',
    };
    await saveStoryboard(projectPath, sb);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/script/generate`,
      payload: { groundInVideo: true },
    });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      error: 'Video-grounded script generation failed. Your existing script was not changed.',
      code: 'video_script_failed',
    });
    expect(ctx.writer.complete).not.toHaveBeenCalled();
    expect((await loadStoryboard(projectPath))!.scenes[0]!.narration).toEqual(
      sb.scenes[0]!.narration,
    );
  });

  it('text-only generation without a recording uses writing and saves both variants', async () => {
    const sb = makeSampleStoryboard(projectId);
    await saveStoryboard(projectPath, sb);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/script/generate`,
      payload: { groundInVideo: false },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sceneId).toBe('scene-01');
    expect(body.script).toBeTruthy();
    expect(body.script).not.toContain('[');  // plain prose — no inline tags
    expect(body.dialog).toBe(DIALOG);
    expect(body.dialogScript).toBe(DIALOG);
    expect(body.mode).toBe('text');
    expect(body.routing).toEqual({ writing: modelSummary('writing') });
    expect(ctx.resolveText).toHaveBeenCalledWith('writing', expect.objectContaining({ id: projectId }));
    expect(ctx.resolveText).toHaveBeenCalledTimes(1);
    expect(ctx.resolveVideo).not.toHaveBeenCalled();

    // Verify it was saved to storyboard
    const updated = await loadStoryboard(projectPath);
    const scene = updated!.scenes.find((s) => s.id === 'scene-01');
    expect(scene?.narration?.script).toBe(body.script);
    expect(scene?.narration?.dialogScript).toBe(DIALOG);
  });

  it('uses the general assignment only when source documents need summarization', async () => {
    const sb = makeSampleStoryboard(projectId);
    await saveStoryboard(projectPath, sb);
    await addText(projectPath, 'f'.repeat(REFERENCE_BUDGET_CHARS + 1), 'large-reference.md');

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/script/generate`,
    });

    expect(res.statusCode).toBe(200);
    expect(ctx.resolveText.mock.calls.map(([role]) => role)).toEqual(['writing', 'general']);
    expect(ctx.general.complete).toHaveBeenCalledTimes(1);
    expect(ctx.writer.complete).toHaveBeenCalledTimes(2);
    expect(ctx.writerComplete.mock.calls[0]![0].userPrompt).toContain('A bounded factual source summary.');
    expect(res.json().routing.general).toEqual(modelSummary('general'));
  });

  it('stages a Gemini brief before writing without crossing provider boundaries', async () => {
    const gemini = {
      uploadVideo: vi.fn(async () => ({
        name: 'files/private-video',
        uri: 'https://generativelanguage.googleapis.com/v1beta/files/private-video',
        mimeType: 'video/mp4',
        state: 'ACTIVE' as const,
      })),
      waitForFileActive: vi.fn(async () => ({
        name: 'files/private-video',
        uri: 'https://generativelanguage.googleapis.com/v1beta/files/private-video',
        mimeType: 'video/mp4',
        state: 'ACTIVE' as const,
      })),
      generateWithVideo: vi.fn(async () => JSON.stringify({
        visual_summary: 'The dashboard opens.',
        segments: [{
          id: 'segment-001',
          start_sec: 0,
          end_sec: 30,
          screen_change: 'The project is created.',
          visible_labels: ['Create project'],
          on_screen_terms: ['Workspace'],
        }],
        pacing_cues: [{ segment_id: 'segment-001', cue: 'Pause after loading.' }],
        narration_cues: [{ segment_id: 'segment-001', cue: 'Explain the result.' }],
        lower_third_candidates: [],
      })),
      deleteFile: vi.fn(async () => true),
    };
    const realVideoUnderstanding = new VideoUnderstandingService({
      workspaceRoot: workspaceRoot(),
      hashFile: async () => 'c'.repeat(64),
      snapshotVideo: async (sourcePath) => ({ path: sourcePath, cleanup: async () => {} }),
      probe: async () => ({
        duration_sec: 30,
        width: 1920,
        height: 1080,
        fps: 30,
        codec: 'h264',
        size_bytes: 1,
      }),
      persist: async () => {},
      readPrompt: async () => 'Return the bounded video brief JSON.',
      transport: gemini,
      warn: vi.fn(),
    });
    await ctx.app.close();
    await rm(ctx.home, { recursive: true, force: true });
    await rm(ctx.projects, { recursive: true, force: true });
    ctx = await buildTestServer({
      videoUnderstanding: realVideoUnderstanding,
      fingerprintRecording: async () => 'c'.repeat(64),
    });
    const project = await ctx.store.create({ name: 'grounded-project', objective: 'Demo grounding' });
    projectId = project.id;
    projectPath = project.path;
    const sb = makeSampleStoryboard(projectId);
    sb.scenes[0]!.recording = { source: 'recordings/scene-01.mp4', duration_sec: 30 };
    await saveStoryboard(projectPath, sb);
    const videoPath = path.join(projectPath, 'recordings/scene-01.mp4');

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/script/generate`,
      payload: { groundInVideo: true },
    });

    expect(res.statusCode).toBe(200);
    expect(gemini.generateWithVideo).toHaveBeenCalledTimes(1);
    expect(ctx.writer.complete).toHaveBeenCalledTimes(2);
    expect(ctx.writerComplete.mock.calls[0]![0].userPrompt).toContain('segment-001');
    expect(ctx.writerComplete.mock.calls[0]![0].userPrompt).not.toContain(videoPath);
    expect(ctx.writerComplete.mock.calls[0]![0].userPrompt).not.toContain(
      'generativelanguage.googleapis.com',
    );
    expect(ctx.resolveText).toHaveBeenCalledWith('writing', expect.objectContaining({ id: projectId }));
    expect(res.json()).toMatchObject({
      mode: 'video',
      briefFreshness: 'generated',
      routing: {
        videoUnderstanding: modelSummary('video-understanding'),
        writing: modelSummary('writing'),
      },
    });
  });

  it('resolves every grounded role before starting video understanding', async () => {
    const events: string[] = [];
    const resolveVideo = vi.fn(async () => {
      events.push('video');
      return ctx.videoModel;
    });
    const resolveText = vi.fn(async (role: 'writing' | 'general') => {
      events.push(role);
      return {
        client: role === 'writing' ? ctx.writer : ctx.general,
        summary: modelSummary(role),
      };
    });
    const videoUnderstanding = {
      readBriefStatus: vi.fn(async () => ({ status: 'missing' as const })),
      ensureBrief: vi.fn(async (input: { videoPath: string }) => {
        events.push('ensure');
        return makeBrief(input.videoPath);
      }),
    };
    await ctx.app.close();
    await rm(ctx.home, { recursive: true, force: true });
    await rm(ctx.projects, { recursive: true, force: true });
    ctx = await buildTestServer({ resolveText, resolveVideo, videoUnderstanding });
    const project = await ctx.store.create({ name: 'ordered-project', objective: 'Demo ordering' });
    projectId = project.id;
    projectPath = project.path;
    const sb = makeSampleStoryboard(projectId);
    sb.scenes[0]!.recording = { source: 'recordings/scene-01.mp4', duration_sec: 30 };
    await saveStoryboard(projectPath, sb);
    await addText(projectPath, 'f'.repeat(REFERENCE_BUDGET_CHARS + 1), 'large-reference.md');

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/script/generate`,
      payload: { groundInVideo: true },
    });

    expect(res.statusCode).toBe(200);
    expect(events).toEqual(['video', 'writing', 'general', 'ensure']);
  });

  it('does not call the writer or mutate scripts when Gemini brief generation fails', async () => {
    const existing = makeSampleStoryboard(projectId);
    existing.scenes[0]!.recording = { source: 'recordings/scene-01.mp4', duration_sec: 30 };
    existing.scenes[0]!.narration = {
      script: 'Existing script.',
      monologueScript: 'Existing script.',
      dialogScript: '[Speaker A] Existing dialog.',
    };
    await saveStoryboard(projectPath, existing);
    ctx.ensureBrief.mockRejectedValueOnce(new Error('private Gemini provider body'));

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/script/generate`,
      payload: { groundInVideo: true },
    });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      error: 'Video-grounded script generation failed. Your existing script was not changed.',
      code: 'video_script_failed',
    });
    expect(ctx.writer.complete).not.toHaveBeenCalled();
    expect((await loadStoryboard(projectPath))!.scenes[0]!.narration).toEqual(existing.scenes[0]!.narration);
  });

  it('preserves both variants when writing or dialog conversion fails', async () => {
    const existing = makeSampleStoryboard(projectId);
    existing.scenes[0]!.narration = {
      script: 'Existing script.',
      monologueScript: 'Existing script.',
      dialogScript: '[Speaker A] Existing dialog.',
    };
    await saveStoryboard(projectPath, existing);
    const complete = vi.fn()
      .mockResolvedValueOnce({ text: 'Generated but not persisted.' })
      .mockRejectedValueOnce(new Error('private dialog provider response'));
    await ctx.app.close();
    await rm(ctx.home, { recursive: true, force: true });
    await rm(ctx.projects, { recursive: true, force: true });
    ctx = await buildTestServer({ writer: { complete } });
    const project = await ctx.store.create({ name: 'preserve-project', objective: 'Demo preservation' });
    projectId = project.id;
    projectPath = project.path;
    const preserved = makeSampleStoryboard(projectId);
    preserved.scenes[0]!.narration = existing.scenes[0]!.narration;
    await saveStoryboard(projectPath, preserved);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/script/generate`,
    });

    expect(res.statusCode).toBe(500);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(res.json().error).not.toContain('private dialog provider response');
    expect((await loadStoryboard(projectPath))!.scenes[0]!.narration).toEqual(preserved.scenes[0]!.narration);
  });

  it('preserves both variants when the writer fails before dialog conversion', async () => {
    const complete = vi.fn(async () => {
      throw new Error('private writer provider response');
    });
    await ctx.app.close();
    await rm(ctx.home, { recursive: true, force: true });
    await rm(ctx.projects, { recursive: true, force: true });
    ctx = await buildTestServer({ writer: { complete } });
    const project = await ctx.store.create({ name: 'writer-failure-project', objective: 'Preserve scripts' });
    projectId = project.id;
    projectPath = project.path;
    const preserved = makeSampleStoryboard(projectId);
    preserved.scenes[0]!.narration = {
      script: 'Existing script.',
      monologueScript: 'Existing script.',
      dialogScript: '[Speaker A] Existing dialog.',
    };
    await saveStoryboard(projectPath, preserved);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/script/generate`,
    });

    expect(res.statusCode).toBe(500);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(res.json()).toEqual({
      error: 'Script generation failed. Your existing script was not changed.',
      code: 'script_generation_failed',
    });
    expect((await loadStoryboard(projectPath))!.scenes[0]!.narration).toEqual(preserved.scenes[0]!.narration);
  });

  it('preserves both variants when general source summarization fails', async () => {
    const generalComplete = vi.fn(async () => {
      throw new Error('private general provider response');
    });
    await ctx.app.close();
    await rm(ctx.home, { recursive: true, force: true });
    await rm(ctx.projects, { recursive: true, force: true });
    ctx = await buildTestServer({ general: { complete: generalComplete } });
    const project = await ctx.store.create({ name: 'general-failure-project', objective: 'Preserve scripts' });
    projectId = project.id;
    projectPath = project.path;
    const preserved = makeSampleStoryboard(projectId);
    preserved.scenes[0]!.narration = {
      script: 'Existing script.',
      monologueScript: 'Existing script.',
      dialogScript: '[Speaker A] Existing dialog.',
    };
    await saveStoryboard(projectPath, preserved);
    await addText(projectPath, 'f'.repeat(REFERENCE_BUDGET_CHARS + 1), 'large-reference.md');

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/script/generate`,
    });

    expect(res.statusCode).toBe(500);
    expect(generalComplete).toHaveBeenCalledTimes(1);
    expect(ctx.writer.complete).not.toHaveBeenCalled();
    expect(res.json().error).not.toContain('private general provider response');
    expect((await loadStoryboard(projectPath))!.scenes[0]!.narration).toEqual(preserved.scenes[0]!.narration);
  });

  it('returns stable routing errors with the failing role before upload work', async () => {
    ctx.resolveText.mockRejectedValueOnce(new ModelRoutingError(
      'model_assignment_missing',
      'writing',
      'global',
      'No model is assigned to the writing role. Choose one in global model settings.',
      422,
    ));
    const sb = makeSampleStoryboard(projectId);
    sb.scenes[0]!.recording = { source: 'recordings/scene-01.mp4', duration_sec: 30 };
    await saveStoryboard(projectPath, sb);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/script/generate`,
      payload: { groundInVideo: true },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'model_assignment_missing', role: 'writing' });
    expect(ctx.ensureBrief).not.toHaveBeenCalled();
    expect(ctx.writer.complete).not.toHaveBeenCalled();
  });

  it.each(['true', 1, null])(
    'rejects malformed groundInVideo value %j before routing or persistence',
    async (groundInVideo) => {
      const existing = makeSampleStoryboard(projectId);
      existing.scenes[0]!.narration = { script: 'Keep me', monologueScript: 'Keep me' };
      await saveStoryboard(projectPath, existing);

      const response = await ctx.app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/scenes/scene-01/script/generate`,
        payload: { groundInVideo },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: 'groundInVideo must be a boolean when provided.',
        code: 'invalid_request',
      });
      expect(ctx.resolveText).not.toHaveBeenCalled();
      expect(ctx.resolveVideo).not.toHaveBeenCalled();
      expect((await loadStoryboard(projectPath))!.scenes[0]!.narration?.script).toBe('Keep me');
    },
  );

  it('rejects undeclared generation fields and a top-level null body', async () => {
    await saveStoryboard(projectPath, makeSampleStoryboard(projectId));
    const extra = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/script/generate`,
      payload: { groundInVideo: false, provider: 'gemini' },
    });
    const topLevelNull = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/script/generate`,
      payload: 'null',
      headers: { 'content-type': 'application/json' },
    });

    expect(extra.statusCode).toBe(400);
    expect(topLevelNull.statusCode).toBe(400);
    expect(ctx.resolveText).not.toHaveBeenCalled();
  });

  it('rejects a same-path replacement fingerprint before persisting a grounded script', async () => {
    const existing = makeSampleStoryboard(projectId);
    existing.scenes[0]!.recording = { source: 'recordings/scene-01.mp4', duration_sec: 30 };
    existing.scenes[0]!.narration = {
      script: 'Existing script.', monologueScript: 'Existing script.', dialogScript: '[Speaker A] Existing dialog.',
    };
    await saveStoryboard(projectPath, existing);
    await ctx.app.close();
    await rm(ctx.home, { recursive: true, force: true });
    await rm(ctx.projects, { recursive: true, force: true });
    ctx = await buildTestServer({ fingerprintRecording: async () => 'c'.repeat(64) });
    const project = await ctx.store.create({ name: 'script-replacement', objective: 'Keep old script' });
    projectId = project.id;
    projectPath = project.path;
    const storyboard = makeSampleStoryboard(projectId);
    storyboard.scenes[0]!.recording = { source: 'recordings/scene-01.mp4', duration_sec: 30 };
    storyboard.scenes[0]!.narration = existing.scenes[0]!.narration;
    await saveStoryboard(projectPath, storyboard);

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/script/generate`,
      payload: { groundInVideo: true },
    });

    expect(response.statusCode).toBe(500);
    expect((await loadStoryboard(projectPath))!.scenes[0]!.narration).toEqual(
      storyboard.scenes[0]!.narration,
    );
  });

  it('holds the shared scene reservation through grounded script persistence', async () => {
    const gate = deferred();
    const complete = vi.fn()
      .mockImplementationOnce(async () => {
        await gate.promise;
        return { text: SCRIPT };
      })
      .mockResolvedValueOnce({ text: DIALOG });
    const reservation = recordingReservation();
    await ctx.app.close();
    await rm(ctx.home, { recursive: true, force: true });
    await rm(ctx.projects, { recursive: true, force: true });
    ctx = await buildTestServer({ writer: { complete }, withRecordingReservation: reservation });
    const project = await ctx.store.create({ name: 'script-reservation' });
    projectId = project.id;
    projectPath = project.path;
    const storyboard = makeSampleStoryboard(projectId);
    storyboard.scenes[0]!.recording = { source: 'recordings/scene-01.mp4', duration_sec: 30 };
    await saveStoryboard(projectPath, storyboard);

    const generation = ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/script/generate`,
      payload: { groundInVideo: true },
    });
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    await expect(reservation(projectId, ['scene-01'], async () => {
      await mkdir(path.join(projectPath, 'recordings'), { recursive: true });
      await writeFile(path.join(projectPath, 'recordings/scene-01.mp4'), 'replacement');
    })).rejects.toThrow('reserved');
    gate.resolve();

    await expect(generation).resolves.toMatchObject({ statusCode: 200 });
    expect((await loadStoryboard(projectPath))!.scenes[0]!.narration?.script).toBe(SCRIPT);
  });

  it('PUT script saves an edited script', async () => {
    const sb = makeSampleStoryboard(projectId);
    await saveStoryboard(projectPath, sb);

    const customScript = '[warm] Welcome to this demo.\n\n[confident] Let me show you how it works.';
    const res = await ctx.app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/scenes/scene-01/script`,
      payload: { script: customScript },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().script).toBe(customScript);

    // Verify saved
    const updated = await loadStoryboard(projectPath);
    const scene = updated!.scenes.find((s) => s.id === 'scene-01');
    expect(scene?.narration?.script).toBe(customScript);
  });

  it('PUT script returns 400 without script field', async () => {
    const sb = makeSampleStoryboard(projectId);
    await saveStoryboard(projectPath, sb);

    const res = await ctx.app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/scenes/scene-01/script`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('invalid_request');
  });

  it('returns 404 for non-existent scene', async () => {
    const sb = makeSampleStoryboard(projectId);
    await saveStoryboard(projectPath, sb);

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/scenes/no-such/script`,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('scene_not_found');
  });

  it('returns 404 when no storyboard exists', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/script/generate`,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('not_found');
  });

  it('POST polish returns a proposal without mutating the storyboard', async () => {
    const sb = makeSampleStoryboard(projectId);
    await saveStoryboard(projectPath, sb);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/script/polish`,
      payload: { draft: 'Welcome to the demo. Let me show you around now.' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sceneId).toBe('scene-01');
    expect(body.originalScript).toBe('Welcome to the demo. Let me show you around now.');
    expect(body.proposedScript).toBeTruthy();
    expect(body.proposedScript).not.toContain('['); // plain prose — no inline tags
    expect(Array.isArray(body.notes)).toBe(true);
    expect(body.currentWords).toBeGreaterThan(0);
    expect(body.proposedWords).toBeGreaterThan(0);
    expect(ctx.resolveText).toHaveBeenCalledWith(
      'writing',
      expect.objectContaining({ id: projectId }),
    );
    expect(ctx.resolveText).not.toHaveBeenCalledWith('general', expect.anything());

    // The storyboard must be untouched — polish only proposes.
    const after = await loadStoryboard(projectPath);
    const scene = after!.scenes.find((s) => s.id === 'scene-01');
    expect(scene?.narration).toBeUndefined();
  });

  it('routes script tightening through writing and leaves the stored script unchanged', async () => {
    const sb = makeSampleStoryboard(projectId);
    const original = Array.from({ length: 80 }, (_, index) => `word${index}`).join(' ');
    sb.scenes[0]!.narration = { script: original, monologueScript: original };
    await saveStoryboard(projectPath, sb);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/script/tighten`,
      payload: { targetDurationSec: 1 },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().proposedWords).toBeLessThan(res.json().currentWords);
    expect(ctx.resolveText).toHaveBeenCalledWith(
      'writing',
      expect.objectContaining({ id: projectId }),
    );
    expect((await loadStoryboard(projectPath))!.scenes[0]!.narration!.script).toBe(original);
  });

  it('uses general only for oversized source-document summarization during polish', async () => {
    await saveStoryboard(projectPath, makeSampleStoryboard(projectId));
    await addText(projectPath, 'f'.repeat(REFERENCE_BUDGET_CHARS + 1), 'large-polish-reference.md');

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/script/polish`,
      payload: { draft: 'A draft grounded in project source material.' },
    });

    expect(res.statusCode).toBe(200);
    expect(ctx.resolveText.mock.calls.map(([role]) => role)).toEqual(['writing', 'general']);
    expect(ctx.general.complete).toHaveBeenCalledOnce();
    expect(ctx.writer.complete).toHaveBeenCalledOnce();
  });

  it('POST polish returns 400 when draft is empty', async () => {
    const sb = makeSampleStoryboard(projectId);
    await saveStoryboard(projectPath, sb);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/script/polish`,
      payload: { draft: '   ' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('no_draft');
  });

  it('POST polish returns 404 for a non-existent scene', async () => {
    const sb = makeSampleStoryboard(projectId);
    await saveStoryboard(projectPath, sb);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/no-such/script/polish`,
      payload: { draft: 'some draft text' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('scene_not_found');
  });

  it('GET script reflects previously generated script', async () => {
    const sb = makeSampleStoryboard(projectId);
    await saveStoryboard(projectPath, sb);

    // Generate
    await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/script/generate`,
    });

    // Read back
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/scenes/scene-01/script`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().script).toBeTruthy();
  });
});
