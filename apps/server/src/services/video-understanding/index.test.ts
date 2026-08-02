import type { VideoUnderstandingBrief } from '@vpa/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedVideoModel } from '../llm/model-router.js';
import type { GeminiFile, GenerateWithVideoInput } from '../video-narration/gemini-files.js';
import {
  VideoUnderstandingError,
  VideoUnderstandingService,
  type EnsureBriefInput,
  type VideoUnderstandingServiceOptions,
} from './index.js';

const input: EnsureBriefInput = {
  projectPath: '/project',
  sceneId: 'scene-1',
  sceneName: 'Create a deployment',
  videoPath: '/private/recordings/secret-name.mp4',
};

const model = (entryId = 'vision', concreteModel = 'gemini-2.5-pro'): ResolvedVideoModel => ({
  apiKey: 'private-api-key',
  model: concreteModel,
  summary: {
    role: 'video-understanding',
    scope: 'global',
    entry_id: entryId,
    provider: 'gemini',
    model: concreteModel,
    name: 'Gemini Vision',
    capabilities: { text: true, video: true },
    ready: true,
  },
});

const modelOutput = JSON.stringify({
  visual_summary: 'A deployment form is completed and submitted.',
  segments: [{
    id: 'segment-001',
    start_sec: 0,
    end_sec: 12,
    screen_change: 'The deployment form opens.',
    visible_labels: ['Create deployment'],
    on_screen_terms: ['Tanzu'],
  }],
  pacing_cues: [{ segment_id: 'segment-001', cue: 'Allow time to scan the form.' }],
  narration_cues: [{ segment_id: 'segment-001', cue: 'Explain the required fields.' }],
  lower_third_candidates: [{ segment_id: 'segment-001', reason: 'Introduce the workflow.' }],
});

const uploaded: GeminiFile = {
  name: 'files/remote-1',
  uri: 'https://generativelanguage.googleapis.com/v1beta/files/remote-1',
  mimeType: 'video/mp4',
  state: 'PROCESSING',
};

const active: GeminiFile = { ...uploaded, state: 'ACTIVE' };

function missing(): Error & { code: string } {
  return Object.assign(new Error('missing'), { code: 'ENOENT' });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fixture(overrides: Partial<VideoUnderstandingServiceOptions> = {}) {
  const files = new Map<string, string>();
  let hash = 'a'.repeat(64);
  const persist = vi.fn(async (path: string, data: string) => {
    files.set(path, data);
  });
  const uploadVideo = vi.fn(async () => uploaded);
  const waitForFileActive = vi.fn(async () => active);
  const generateWithVideo = vi.fn(async (_request: GenerateWithVideoInput) => modelOutput);
  const deleteFile = vi.fn(async () => true);
  const warn = vi.fn();
  const defaults: VideoUnderstandingServiceOptions = {
    workspaceRoot: '/workspace',
    readTextFile: async (path) => {
      const value = files.get(path);
      if (value === undefined) throw missing();
      return value;
    },
    hashFile: async () => hash,
    probe: async () => ({
      duration_sec: 12,
      width: 1920,
      height: 1080,
      codec: 'h264',
      fps: 30,
      size_bytes: 100,
    }),
    persist,
    readPrompt: async () => 'Return only the bounded JSON fields.',
    transport: { uploadVideo, waitForFileActive, generateWithVideo, deleteFile },
    now: () => new Date('2026-08-02T12:00:00.000Z'),
    warn,
  };
  const service = new VideoUnderstandingService({ ...defaults, ...overrides });
  return {
    service,
    files,
    persist,
    uploadVideo,
    waitForFileActive,
    generateWithVideo,
    deleteFile,
    warn,
    setHash(value: string) { hash = value; },
  };
}

describe('VideoUnderstandingService', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('generates and atomically persists a missing brief once', async () => {
    const ctx = fixture();
    const phases: string[] = [];

    const brief = await ctx.service.ensureBrief(input, model(), (phase) => phases.push(phase));

    expect(brief.scene_id).toBe('scene-1');
    expect(brief.source.sha256).toBe('a'.repeat(64));
    expect(brief.model.entry_id).toBe('vision');
    expect(ctx.persist).toHaveBeenCalledTimes(1);
    expect(ctx.uploadVideo).toHaveBeenCalledTimes(1);
    expect(ctx.generateWithVideo).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gemini-2.5-pro',
      responseMimeType: 'application/json',
    }));
    expect(ctx.generateWithVideo.mock.calls[0]![0].userPrompt).not.toContain(input.videoPath);
    expect(phases).toEqual([
      'hashing', 'uploading', 'processing', 'analyzing', 'validating', 'saving', 'done',
    ]);
  });

  it('reuses an exactly matching artifact without uploading', async () => {
    const ctx = fixture();
    const first = await ctx.service.ensureBrief(input, model());
    const status = await ctx.service.readBriefStatus(input, model());
    const second = await ctx.service.ensureBrief(input, model());

    expect(status).toEqual({ status: 'fresh', brief: first });
    expect(second).toEqual(first);
    expect(ctx.uploadVideo).toHaveBeenCalledTimes(1);
    expect(ctx.persist).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['changed source bytes', () => ({ hash: 'b'.repeat(64), model: model() })],
    ['changed model entry', () => ({ hash: 'a'.repeat(64), model: model('vision-next') })],
    ['changed concrete model', () => ({ hash: 'a'.repeat(64), model: model('vision', 'gemini-3-pro') })],
  ])('regenerates for %s', async (_label, change) => {
    const ctx = fixture();
    await ctx.service.ensureBrief(input, model());
    const next = change();
    ctx.setHash(next.hash);

    const brief = await ctx.service.ensureBrief(input, next.model);

    expect(brief.source.sha256).toBe(next.hash);
    expect(brief.model.entry_id).toBe(next.model.summary.entry_id);
    expect(brief.model.model).toBe(next.model.model);
    expect(ctx.uploadVideo).toHaveBeenCalledTimes(2);
  });

  it.each(['schema_version', 'prompt_version'] as const)(
    'regenerates when persisted %s is not current',
    async (versionField) => {
      const ctx = fixture();
      await ctx.service.ensureBrief(input, model());
      const path = '/project/analysis/video/scene-1.json';
      const stale = JSON.parse(ctx.files.get(path)!) as VideoUnderstandingBrief;
      ctx.files.set(path, JSON.stringify({ ...stale, [versionField]: 999 }));

      await ctx.service.ensureBrief(input, model());

      expect(ctx.uploadVideo).toHaveBeenCalledTimes(2);
    },
  );

  it('deduplicates concurrent generation with the exact freshness key', async () => {
    const gate = deferred<string>();
    const ctx = fixture({
      transport: {
        uploadVideo: vi.fn(async () => uploaded),
        waitForFileActive: vi.fn(async () => active),
        generateWithVideo: vi.fn(() => gate.promise),
        deleteFile: vi.fn(async () => true),
      },
    });

    const first = ctx.service.ensureBrief(input, model());
    const second = ctx.service.ensureBrief(input, model());
    await vi.waitFor(() => {
      const transport = (ctx.service as unknown as { transport: { generateWithVideo: ReturnType<typeof vi.fn> } }).transport;
      expect(transport.generateWithVideo).toHaveBeenCalledTimes(1);
    });
    gate.resolve(modelOutput);

    const [one, two] = await Promise.all([first, second]);
    expect(two).toEqual(one);
  });

  it.each([
    ['invalid JSON', '{not-json'],
    ['invalid model fields', JSON.stringify({ visual_summary: 'missing arrays' })],
    ['VPA-owned fields', JSON.stringify({ ...JSON.parse(modelOutput), scene_id: 'injected' })],
  ])('does not persist %s', async (_label, output) => {
    const ctx = fixture({
      transport: {
        uploadVideo: vi.fn(async () => uploaded),
        waitForFileActive: vi.fn(async () => active),
        generateWithVideo: vi.fn(async () => output),
        deleteFile: vi.fn(async () => true),
      },
    });

    await expect(ctx.service.ensureBrief(input, model())).rejects.toBeInstanceOf(VideoUnderstandingError);
    expect(ctx.persist).not.toHaveBeenCalled();
  });

  it('deletes the remote file in finally after success and generation failure', async () => {
    const success = fixture();
    await success.service.ensureBrief(input, model());
    expect(success.deleteFile).toHaveBeenCalledWith('private-api-key', 'files/remote-1');

    const failedDelete = vi.fn(async () => true);
    const failed = fixture({
      transport: {
        uploadVideo: vi.fn(async () => uploaded),
        waitForFileActive: vi.fn(async () => active),
        generateWithVideo: vi.fn(async () => { throw new Error('provider failed'); }),
        deleteFile: failedDelete,
      },
    });
    await expect(failed.service.ensureBrief(input, model())).rejects.toBeInstanceOf(VideoUnderstandingError);
    expect(failedDelete).toHaveBeenCalledWith('private-api-key', 'files/remote-1');
  });

  it('warns privately when deletion fails without discarding a valid brief', async () => {
    const warn = vi.fn();
    const ctx = fixture({
      warn,
      transport: {
        uploadVideo: vi.fn(async () => uploaded),
        waitForFileActive: vi.fn(async () => active),
        generateWithVideo: vi.fn(async () => modelOutput),
        deleteFile: vi.fn(async () => { throw new Error(active.uri); }),
      },
    });

    const brief = await ctx.service.ensureBrief(input, model());

    expect(brief.visual_summary).toContain('deployment form');
    expect(warn).toHaveBeenCalledWith(
      { sceneId: 'scene-1', errorName: 'Error' },
      'Gemini video cleanup failed',
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain(active.uri);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(input.videoPath);
  });

  it('does not discard a valid brief when the private warning sink also fails', async () => {
    const ctx = fixture({
      warn: () => { throw new Error('logger unavailable'); },
      transport: {
        uploadVideo: vi.fn(async () => uploaded),
        waitForFileActive: vi.fn(async () => active),
        generateWithVideo: vi.fn(async () => modelOutput),
        deleteFile: vi.fn(async () => false),
      },
    });

    await expect(ctx.service.ensureBrief(input, model()))
      .resolves.toMatchObject({ scene_id: 'scene-1' });
    expect(ctx.persist).toHaveBeenCalledTimes(1);
  });

  it('never returns a stale artifact when regeneration fails', async () => {
    const ctx = fixture();
    const stale = await ctx.service.ensureBrief(input, model());
    ctx.setHash('c'.repeat(64));
    ctx.generateWithVideo.mockRejectedValueOnce(new Error('generation failed'));

    await expect(ctx.service.ensureBrief(input, model())).rejects.toBeInstanceOf(VideoUnderstandingError);

    const saved = JSON.parse(ctx.files.get('/project/analysis/video/scene-1.json')!);
    expect(saved).toEqual(stale);
    await expect(ctx.service.readBriefStatus(input, model())).resolves.toEqual({ status: 'stale' });
  });

  it('rejects unsafe scene IDs before filesystem or model access', async () => {
    const ctx = fixture();

    await expect(ctx.service.ensureBrief({ ...input, sceneId: '../escape' }, model()))
      .rejects.toThrow('Scene ID contains unsupported characters.');
    expect(ctx.uploadVideo).not.toHaveBeenCalled();
    expect(ctx.persist).not.toHaveBeenCalled();
  });
});
