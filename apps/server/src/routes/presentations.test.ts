import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import FormData from 'form-data';
import { constants } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PresentationJob, PresentationManifest, Project, Scene } from '@vpa/shared';
import { ProjectStore } from '../services/project/store.js';
import { PresentationImportService } from '../services/presentation/import-service.js';
import { PresentationNarrationDrafter } from '../services/presentation/narration-drafter.js';
import { PresentationJobStore } from '../services/presentation/job-store.js';
import { createStoryboard, loadStoryboard, saveStoryboard } from '../services/storyboard/index.js';
import { projectFiles } from '../services/project/paths.js';
import { registerPresentationRoutes } from './presentations.js';

const PRESENTATION_ID = '22222222-2222-4222-8222-222222222222';
const SECOND_PRESENTATION_ID = '33333333-3333-4333-8333-333333333333';
const NOW = '2026-08-05T12:00:00.000Z';

function job(overrides: Partial<PresentationJob> = {}): PresentationJob {
  return {
    schema_version: 1,
    id: PRESENTATION_ID,
    project_id: '11111111-1111-4111-8111-111111111111',
    filename: 'Quarterly Review.pdf',
    status: 'processing',
    stage: 'processing-slides',
    generate_narration: true,
    page_count: 0,
    processed_pages: 0,
    analyzed_pages: 0,
    scripted_pages: 0,
    remaining_scene_count: 0,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function multipartPayload(parts: Array<
  | { kind: 'file'; bytes: Buffer; filename?: string; contentType?: string }
  | { kind: 'field'; value: string }
>) {
  const form = new FormData();
  for (const part of parts) {
    if (part.kind === 'file') {
      form.append('file', part.bytes, {
        filename: part.filename ?? 'slides.pdf',
        contentType: part.contentType ?? 'application/pdf',
      });
    } else {
      form.append('generate_narration', part.value);
    }
  }
  return { payload: form.getBuffer(), headers: form.getHeaders() };
}

function committedManifest(targetProject: Project, presentationId: string): PresentationManifest {
  return {
    schema_version: 1,
    id: presentationId,
    project_id: targetProject.id,
    display_name: 'Slides.pdf',
    source_sha256: 'a'.repeat(64),
    size_bytes: 7,
    page_count: 1,
    created_at: NOW,
    updated_at: NOW,
    generate_narration: true,
    pages: [{
      page_number: 1,
      scene_id: 'scene-slide',
      image: `presentations/${presentationId}/pages/page-0001.png`,
      clip: `presentations/${presentationId}/clips/page-0001.mp4`,
      extracted_text: 'Visible slide text',
      baseline: { name: 'Slide 1', description: 'Baseline', narration_script: null },
      analysis_status: 'pending',
      script_status: 'pending',
    }],
  };
}

function committedScene(presentationId: string): Scene {
  return {
    id: 'scene-slide',
    name: 'Slide 1',
    description: 'Baseline',
    type: 'slide',
    recording: {
      source: `presentations/${presentationId}/clips/page-0001.mp4`,
      source_kind: 'presentation',
      duration_sec: 1,
    },
    presentation_source: {
      presentation_id: presentationId,
      page_number: 1,
      page_count: 1,
      image: `presentations/${presentationId}/pages/page-0001.png`,
      hold_duration_sec: 5,
    },
  };
}

async function persistCommittedBundle(targetProject: Project, presentationId: string): Promise<void> {
  const bundle = path.join(projectFiles(targetProject.path).presentationsDir, presentationId);
  await mkdir(path.join(bundle, 'pages'), { recursive: true });
  await mkdir(path.join(bundle, 'clips'), { recursive: true });
  await writeFile(path.join(bundle, 'pages', 'page-0001.png'), 'image');
  await writeFile(path.join(bundle, 'clips', 'page-0001.mp4'), 'clip');
  await writeFile(path.join(bundle, 'manifest.json'), JSON.stringify(
    committedManifest(targetProject, presentationId),
  ));
  await saveStoryboard(targetProject.path, createStoryboard(
    targetProject,
    [committedScene(presentationId)],
  ));
}

describe('presentation routes', () => {
  let root: string;
  let app: FastifyInstance;
  let store: ProjectStore;
  let project: Project;
  let service: {
    registerUpload: Mock<Parameters<PresentationImportService['registerUpload']>, ReturnType<PresentationImportService['registerUpload']>>;
    process: Mock<Parameters<PresentationImportService['process']>, ReturnType<PresentationImportService['process']>>;
    list: Mock<Parameters<PresentationImportService['list']>, ReturnType<PresentationImportService['list']>>;
    get: Mock<Parameters<PresentationImportService['get']>, ReturnType<PresentationImportService['get']>>;
    retryImport: Mock<Parameters<PresentationImportService['retryImport']>, ReturnType<PresentationImportService['retryImport']>>;
    retryNarration: Mock<Parameters<PresentationImportService['retryNarration']>, ReturnType<PresentationImportService['retryNarration']>>;
    remove: Mock<Parameters<PresentationImportService['remove']>, ReturnType<PresentationImportService['remove']>>;
  };
  let drafter: {
    run: Mock<Parameters<PresentationNarrationDrafter['run']>, ReturnType<PresentationNarrationDrafter['run']>>;
    retry: Mock<Parameters<PresentationNarrationDrafter['retry']>, ReturnType<PresentationNarrationDrafter['retry']>>;
  };

  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), 'vpa-presentation-routes-')));
    store = new ProjectStore({
      vpaHome: path.join(root, 'home'),
      projectsDefault: path.join(root, 'projects'),
    });
    project = await store.create({ name: 'route-test' });
    service = {
      registerUpload: vi.fn<Parameters<PresentationImportService['registerUpload']>, ReturnType<PresentationImportService['registerUpload']>>(async (input) => job({
        id: input.id,
        project_id: input.project.id,
      })),
      process: vi.fn<Parameters<PresentationImportService['process']>, ReturnType<PresentationImportService['process']>>(async () => job({ project_id: project.id, status: 'ready', stage: 'ready' })),
      list: vi.fn<Parameters<PresentationImportService['list']>, ReturnType<PresentationImportService['list']>>(async () => [job({ project_id: project.id })]),
      get: vi.fn<Parameters<PresentationImportService['get']>, ReturnType<PresentationImportService['get']>>(async () => job({ project_id: project.id })),
      retryImport: vi.fn<Parameters<PresentationImportService['retryImport']>, ReturnType<PresentationImportService['retryImport']>>(async () => job({ project_id: project.id, status: 'ready', stage: 'ready' })),
      retryNarration: vi.fn<Parameters<PresentationImportService['retryNarration']>, ReturnType<PresentationImportService['retryNarration']>>(async (targetProject, presentationId, callback) => callback(targetProject, presentationId)),
      remove: vi.fn<Parameters<PresentationImportService['remove']>, ReturnType<PresentationImportService['remove']>>(async () => undefined),
    };
    drafter = {
      run: vi.fn<Parameters<PresentationNarrationDrafter['run']>, ReturnType<PresentationNarrationDrafter['run']>>(async () => job({
        project_id: project.id,
        status: 'ready',
        stage: 'ready',
        deterministic_commit: 'committed',
      })),
      retry: vi.fn<Parameters<PresentationNarrationDrafter['retry']>, ReturnType<PresentationNarrationDrafter['retry']>>(async () => job({
        project_id: project.id,
        status: 'ready',
        stage: 'ready',
        deterministic_commit: 'committed',
      })),
    };
    app = Fastify({ logger: false });
    await app.register(multipart);
    await registerPresentationRoutes(app, {
      store,
      service: service as unknown as PresentationImportService,
      maxBytes: 32,
      drafter: drafter as unknown as PresentationNarrationDrafter,
    });
  });

  afterEach(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  it.each([
    ['before', [
      { kind: 'field', value: 'false' } as const,
      { kind: 'file', bytes: Buffer.from('%PDF route bytes') } as const,
    ]],
    ['after', [
      { kind: 'file', bytes: Buffer.from('%PDF route bytes') } as const,
      { kind: 'field', value: 'false' } as const,
    ]],
  ])('accepts one streamed file with generate_narration=false %s the file', async (_order, parts) => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/presentations`,
      ...multipartPayload(parts),
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      presentation_id: expect.any(String),
      job: { stage: 'processing-slides', status: 'processing' },
    });
    const input = service.registerUpload.mock.calls[0]![0] as {
      id: string;
      stagedSourcePath: string;
      sizeBytes: number;
      generateNarration: boolean;
    };
    expect(input.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(input.stagedSourcePath).toBe(
      path.join(project.path, '.presentation-staging', input.id, 'source.pdf'),
    );
    expect(input.sizeBytes).toBe(Buffer.byteLength('%PDF route bytes'));
    expect(input.generateNarration).toBe(false);
    expect(await readFile(input.stagedSourcePath, 'utf8')).toBe('%PDF route bytes');
    expect((await stat(input.stagedSourcePath)).mode & 0o777).toBe(0o600);
    await vi.waitFor(() => expect(service.process).toHaveBeenCalledWith(project, input.id));
    expect(drafter.run).not.toHaveBeenCalled();
  });

  it('starts narration only after detached deterministic processing returns a committed drafting job', async () => {
    service.process.mockImplementationOnce(async (_project, presentationId) => job({
      id: presentationId,
      project_id: project.id,
      status: 'processing',
      stage: 'drafting-narration',
      deterministic_commit: 'committed',
      page_count: 3,
      processed_pages: 3,
      remaining_scene_count: 3,
    }));

    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/presentations`,
      ...multipartPayload([{ kind: 'file', bytes: Buffer.from('%PDF route bytes') }]),
    });

    expect(response.statusCode).toBe(202);
    const presentationId = response.json().presentation_id as string;
    await vi.waitFor(() => expect(drafter.run).toHaveBeenCalledWith(project, presentationId));
  });

  it('makes a detached narration persistence failure visible through the real job store', async () => {
    const realJobs = new PresentationJobStore({ warn: vi.fn() });
    const complete = vi.fn(async () => ({ text: 'Narration that must never be requested.' }));
    const realDrafter = new PresentationNarrationDrafter({
      workspaceRoot: root,
      jobs: realJobs,
      warn: vi.fn(),
      readPrompt: async () => 'Narration prompt.',
      router: {
        resolveVisual: async () => ({
          apiKey: 'private',
          model: 'gemini-2.5-pro',
          summary: {
            role: 'video-understanding',
            scope: 'global',
            entry_id: 'visual-entry',
            provider: 'gemini',
            model: 'gemini-2.5-pro',
            name: 'Visual',
            capabilities: { text: true, image: true, video: true },
            ready: true,
          },
        }),
        resolveText: async () => ({
          client: { complete },
          summary: {
            role: 'writing',
            scope: 'global',
            entry_id: 'writer-entry',
            provider: 'fake',
            model: 'writer-v1',
            name: 'Writer',
            capabilities: { text: true, image: false, video: false },
            ready: true,
          },
        }),
      } as never,
      slideUnderstanding: { ensureBrief: vi.fn() } as never,
      writeContainedFile: async () => {
        throw new Error('injected manifest persistence failure');
      },
    });
    const realService = {
      registerUpload: async (input: Parameters<PresentationImportService['registerUpload']>[0]) => (
        realJobs.create(input.project.path, job({
          id: input.id,
          project_id: input.project.id,
          filename: input.filename,
          generate_narration: input.generateNarration,
        }))
      ),
      process: async (targetProject: Project, presentationId: string) => {
        await persistCommittedBundle(targetProject, presentationId);
        return realJobs.update(targetProject.path, presentationId, {
          status: 'processing',
          stage: 'drafting-narration',
          deterministic_commit: 'committed',
          page_count: 1,
          processed_pages: 1,
          remaining_scene_count: 1,
        });
      },
      list: (projectPath: string) => realJobs.list(projectPath),
      get: (projectPath: string, presentationId: string) => realJobs.read(projectPath, presentationId),
      retryImport: vi.fn(),
      retryNarration: vi.fn(),
      remove: vi.fn(),
    };
    const detachedApp = Fastify({ logger: false });
    await detachedApp.register(multipart);
    await registerPresentationRoutes(detachedApp, {
      store,
      service: realService as unknown as PresentationImportService,
      maxBytes: 32,
      drafter: realDrafter,
    });

    try {
      const response = await detachedApp.inject({
        method: 'POST',
        url: `/api/projects/${project.id}/presentations`,
        ...multipartPayload([{ kind: 'file', bytes: Buffer.from('%PDF route bytes') }]),
      });
      expect(response.statusCode).toBe(202);
      const presentationId = response.json().presentation_id as string;
      await vi.waitFor(async () => {
        expect(await realJobs.read(project.path, presentationId)).toMatchObject({
          status: 'partial',
          stage: 'drafting-narration',
          error: {
            code: 'narration_operational_failure',
            message: 'Presentation narration encountered an operational failure',
          },
        });
      });
      const visible = await detachedApp.inject({
        method: 'GET',
        url: `/api/projects/${project.id}/presentations/${presentationId}`,
      });
      expect(visible.statusCode).toBe(200);
      expect(visible.json()).toMatchObject({ status: 'partial', stage: 'drafting-narration' });
      expect(complete).not.toHaveBeenCalled();
    } finally {
      await detachedApp.close();
    }
  });

  it('does not resurrect a deleted presentation when narration is released from a running model call', async () => {
    const realJobs = new PresentationJobStore({ warn: vi.fn() });
    await realJobs.create(project.path, job({
      project_id: project.id,
      status: 'partial',
      stage: 'drafting-narration',
      page_count: 1,
      processed_pages: 1,
      remaining_scene_count: 1,
      deterministic_commit: 'committed',
    }));
    await persistCommittedBundle(project, PRESENTATION_ID);
    let signalStarted!: () => void;
    let releaseModel!: () => void;
    const modelStarted = new Promise<void>((resolve) => { signalStarted = resolve; });
    const modelRelease = new Promise<void>((resolve) => { releaseModel = resolve; });
    const complete = vi.fn(async () => ({ text: 'Narration that must never be requested.' }));
    const realDrafter = new PresentationNarrationDrafter({
      workspaceRoot: root,
      jobs: realJobs,
      warn: vi.fn(),
      readPrompt: async () => 'Narration prompt.',
      router: {
        resolveVisual: async () => ({
          apiKey: 'private',
          model: 'gemini-2.5-pro',
          summary: {
            role: 'video-understanding',
            scope: 'global',
            entry_id: 'visual-entry',
            provider: 'gemini',
            model: 'gemini-2.5-pro',
            name: 'Visual',
            capabilities: { text: true, image: true, video: true },
            ready: true,
          },
        }),
        resolveText: async () => ({
          client: { complete },
          summary: {
            role: 'writing',
            scope: 'global',
            entry_id: 'writer-entry',
            provider: 'fake',
            model: 'writer-v1',
            name: 'Writer',
            capabilities: { text: true, image: false, video: false },
            ready: true,
          },
        }),
      } as never,
      slideUnderstanding: {
        ensureBrief: async () => {
          signalStarted();
          await modelRelease;
          throw new Error('model stopped after deletion');
        },
      } as never,
    });
    const realService = new PresentationImportService({
      jobs: realJobs,
      maxPages: 200,
      warn: vi.fn(),
    });
    const raceApp = Fastify({ logger: false });
    await raceApp.register(multipart);
    await registerPresentationRoutes(raceApp, {
      store,
      service: realService,
      maxBytes: 32,
      drafter: realDrafter,
    });

    try {
      const retry = raceApp.inject({
        method: 'POST',
        url: `/api/projects/${project.id}/presentations/${PRESENTATION_ID}/retry-narration`,
      }).then((response) => response);
      const firstPhase = await Promise.race([
        modelStarted.then(() => ({ kind: 'model' as const })),
        retry.then((response) => ({
          kind: 'response' as const,
          statusCode: response.statusCode,
          body: response.body,
        })),
      ]);
      expect(firstPhase).toEqual({ kind: 'model' });
      const deletion = await raceApp.inject({
        method: 'DELETE',
        url: `/api/projects/${project.id}/presentations/${PRESENTATION_ID}?confirmed=true`,
      });
      expect(deletion.statusCode).toBe(204);
      releaseModel();
      expect((await retry).statusCode).toBe(500);

      expect(await realJobs.read(project.path, PRESENTATION_ID)).toBeNull();
      const publicLookup = await raceApp.inject({
        method: 'GET',
        url: `/api/projects/${project.id}/presentations/${PRESENTATION_ID}`,
      });
      expect(publicLookup.statusCode).toBe(404);
      await expect(stat(path.join(
        projectFiles(project.path).presentationsDir,
        PRESENTATION_ID,
      ))).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await loadStoryboard(project.path))?.scenes).toEqual([]);
      expect(complete).not.toHaveBeenCalled();
    } finally {
      releaseModel();
      await raceApp.close();
    }
  });

  it.each([
    ['failed processing', { status: 'failed', stage: 'failed', deterministic_commit: 'uncommitted' }],
    ['uncommitted drafting', { status: 'processing', stage: 'drafting-narration', deterministic_commit: 'commit-pending' }],
    ['deletion pending', { status: 'processing', stage: 'drafting-narration', deterministic_commit: 'committed', deletion_pending: true }],
  ])('does not start narration after %s', async (_case, state) => {
    service.process.mockImplementationOnce(async (_project, presentationId) => job({
      id: presentationId,
      project_id: project.id,
      ...state,
    } as Partial<PresentationJob>));

    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/presentations`,
      ...multipartPayload([{ kind: 'file', bytes: Buffer.from('%PDF route bytes') }]),
    });

    expect(response.statusCode).toBe(202);
    await vi.waitFor(() => expect(service.process).toHaveBeenCalledOnce());
    await new Promise((resolve) => setImmediate(resolve));
    expect(drafter.run).not.toHaveBeenCalled();
  });

  it('delegates PDF content validation to detached service processing instead of trusting metadata', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/presentations`,
      ...multipartPayload([{
        kind: 'file',
        bytes: Buffer.from('not a pdf'),
        filename: 'looks-safe.pdf',
        contentType: 'application/pdf',
      }]),
    });

    expect(response.statusCode).toBe(202);
    await vi.waitFor(() => expect(service.process).toHaveBeenCalledTimes(1));
  });

  it.each([
    ['missing file', []],
    ['empty file', [{ kind: 'file', bytes: Buffer.alloc(0) }]],
    ['multiple files', [
      { kind: 'file', bytes: Buffer.from('%PDF first') },
      { kind: 'file', bytes: Buffer.from('%PDF second') },
    ]],
  ])('rejects %s without registering an upload', async (_case, parts) => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/presentations`,
      ...multipartPayload(parts as Array<{ kind: 'file'; bytes: Buffer }>),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'invalid_upload' });
    expect(service.registerUpload).not.toHaveBeenCalled();
    const staging = projectFiles(project.path).presentationStagingDir;
    await expect(stat(staging)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('maps the configured streaming limit to file_too_large and removes partial staging', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/presentations`,
      ...multipartPayload([{ kind: 'file', bytes: Buffer.alloc(33, 1) }]),
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toEqual({
      error: 'The presentation exceeds the upload size limit',
      code: 'file_too_large',
    });
    expect(service.registerUpload).not.toHaveBeenCalled();
    await expect(stat(projectFiles(project.path).presentationStagingDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects invalid narration booleans without registering an upload', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/presentations`,
      ...multipartPayload([
        { kind: 'file', bytes: Buffer.from('%PDF valid') },
        { kind: 'field', value: 'definitely' },
      ]),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'invalid_upload' });
    expect(service.registerUpload).not.toHaveBeenCalled();
  });

  it('maps a non-multipart upload to the stable invalid_upload envelope', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/presentations`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'Upload one non-empty PDF file', code: 'invalid_upload' });
    expect(service.registerUpload).not.toHaveBeenCalled();
  });

  it('returns stable missing-project and identifier errors before touching the service', async () => {
    const missing = await app.inject({
      method: 'GET',
      url: '/api/projects/44444444-4444-4444-8444-444444444444/presentations',
    });
    const invalidPresentation = await app.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/presentations/not-a-uuid`,
    });
    const invalidPage = await app.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/presentations/${PRESENTATION_ID}/pages/0/image`,
    });

    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: 'Project not found', code: 'not_found' });
    expect(invalidPresentation.statusCode).toBe(400);
    expect(invalidPresentation.json()).toMatchObject({ code: 'invalid_presentation_id' });
    expect(invalidPage.statusCode).toBe(400);
    expect(invalidPage.json()).toMatchObject({ code: 'invalid_page_number' });
    expect(service.list).not.toHaveBeenCalled();
    expect(service.get).not.toHaveBeenCalled();
  });

  it('lists and gets validated project presentation jobs', async () => {
    const list = await app.inject({ method: 'GET', url: `/api/projects/${project.id}/presentations` });
    const get = await app.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/presentations/${PRESENTATION_ID}`,
    });

    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({ presentations: [expect.objectContaining({ id: PRESENTATION_ID })] });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toMatchObject({ id: PRESENTATION_ID });
    expect(service.list).toHaveBeenCalledWith(project.path);
    expect(service.get).toHaveBeenCalledWith(project.path, PRESENTATION_ID);
  });

  it('returns not_found when a validated presentation job does not exist', async () => {
    service.get.mockResolvedValueOnce(null);
    const response = await app.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/presentations/${PRESENTATION_ID}`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'Presentation not found', code: 'not_found' });
  });

  it('returns the retry-import job and keeps deterministic errors bounded', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/presentations/${PRESENTATION_ID}/retry-import`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: PRESENTATION_ID, stage: 'ready' });
    expect(service.retryImport).toHaveBeenCalledWith(project, PRESENTATION_ID);
  });

  it('retries narration through the lifecycle-checked service callback', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/presentations/${PRESENTATION_ID}/retry-narration`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: PRESENTATION_ID, stage: 'ready' });
    expect(service.retryNarration).toHaveBeenCalledWith(project, PRESENTATION_ID, expect.any(Function));
    expect(drafter.retry).toHaveBeenCalledWith(project, PRESENTATION_ID);
  });

  it('returns not_found without invoking narration retry for a public tombstone', async () => {
    service.get.mockResolvedValueOnce(null);
    const callbackApp = Fastify({ logger: false });
    await callbackApp.register(multipart);
    await registerPresentationRoutes(callbackApp, {
      store,
      service: service as unknown as PresentationImportService,
      maxBytes: 32,
      drafter: drafter as unknown as PresentationNarrationDrafter,
    });
    try {
      const response = await callbackApp.inject({
        method: 'POST',
        url: `/api/projects/${project.id}/presentations/${PRESENTATION_ID}/retry-narration`,
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: 'Presentation not found', code: 'not_found' });
      expect(drafter.retry).not.toHaveBeenCalled();
    } finally {
      await callbackApp.close();
    }
  });

  it('requires confirmed=true before deletion and returns 204 after service removal', async () => {
    const unconfirmed = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${project.id}/presentations/${PRESENTATION_ID}`,
    });
    const confirmed = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${project.id}/presentations/${PRESENTATION_ID}?confirmed=true`,
    });

    expect(unconfirmed.statusCode).toBe(400);
    expect(unconfirmed.json()).toMatchObject({ code: 'confirmation_required' });
    expect(confirmed.statusCode).toBe(204);
    expect(confirmed.body).toBe('');
    expect(service.remove).toHaveBeenCalledWith(project, PRESENTATION_ID);
  });

  it('returns not_found when a repeated delete sees the public tombstone as absent', async () => {
    service.remove.mockImplementationOnce(async () => {
      service.get.mockResolvedValue(null);
    });
    const url = `/api/projects/${project.id}/presentations/${PRESENTATION_ID}?confirmed=true`;

    const first = await app.inject({ method: 'DELETE', url });
    const repeated = await app.inject({ method: 'DELETE', url });

    expect(first.statusCode).toBe(204);
    expect(repeated.statusCode).toBe(404);
    expect(repeated.json()).toEqual({ error: 'Presentation not found', code: 'not_found' });
    expect(service.remove).toHaveBeenCalledTimes(1);
  });

  it('rejects cross-project and malformed lookup results before destructive removal', async () => {
    const unsafeResults = [
      job({ project_id: '44444444-4444-4444-8444-444444444444' }),
      { id: PRESENTATION_ID, project_id: project.id },
    ];
    for (const value of unsafeResults) {
      service.get.mockResolvedValueOnce(value as PresentationJob);
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/projects/${project.id}/presentations/${PRESENTATION_ID}?confirmed=true`,
      });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({
        error: 'Presentation request failed',
        code: 'presentation_failed',
      });
    }
    expect(service.remove).not.toHaveBeenCalled();
  });

  it('serves only the normalized PNG selected from a validated manifest page record', async () => {
    const bundle = path.join(projectFiles(project.path).presentationsDir, PRESENTATION_ID);
    const imageRelative = `presentations/${PRESENTATION_ID}/pages/page-0001.png`;
    const imagePath = path.join(bundle, 'pages', 'page-0001.png');
    await mkdir(path.dirname(imagePath), { recursive: true });
    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
    const manifest: PresentationManifest = {
      schema_version: 1,
      id: PRESENTATION_ID,
      project_id: project.id,
      display_name: 'Slides.pdf',
      source_sha256: 'a'.repeat(64),
      size_bytes: 7,
      page_count: 1,
      created_at: NOW,
      updated_at: NOW,
      generate_narration: false,
      pages: [{
        page_number: 1,
        scene_id: 'scene-slide',
        image: imageRelative,
        clip: `presentations/${PRESENTATION_ID}/clips/page-0001.mp4`,
        extracted_text: '',
        baseline: { name: 'Slide 1', description: '', narration_script: null },
        analysis_status: 'not-requested',
        script_status: 'not-requested',
      }],
    };
    await writeFile(path.join(bundle, 'manifest.json'), JSON.stringify(manifest));
    await writeFile(path.join(root, 'secret.png'), 'secret');

    const response = await app.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/presentations/${PRESENTATION_ID}/pages/1/image?path=../../secret.png`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/png');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.rawPayload).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  });

  it('rejects a malformed manifest and never resolves an arbitrary page-image path', async () => {
    const bundle = path.join(projectFiles(project.path).presentationsDir, PRESENTATION_ID);
    await mkdir(bundle, { recursive: true });
    await writeFile(path.join(bundle, 'manifest.json'), JSON.stringify({
      id: PRESENTATION_ID,
      project_id: project.id,
      pages: [{ page_number: 1, image: '../../secret.png' }],
    }));

    const response = await app.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/presentations/${PRESENTATION_ID}/pages/1/image`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'Presentation page image not found', code: 'not_found' });
  });

  it('rejects a canonical manifest image path whose file is a symlink outside the bundle', async () => {
    const bundle = path.join(projectFiles(project.path).presentationsDir, PRESENTATION_ID);
    const imageRelative = `presentations/${PRESENTATION_ID}/pages/page-0001.png`;
    const imagePath = path.join(bundle, 'pages', 'page-0001.png');
    const outside = path.join(root, 'outside.png');
    await mkdir(path.dirname(imagePath), { recursive: true });
    await writeFile(outside, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await symlink(outside, imagePath);
    const manifest: PresentationManifest = {
      schema_version: 1,
      id: PRESENTATION_ID,
      project_id: project.id,
      display_name: 'Slides.pdf',
      source_sha256: 'a'.repeat(64),
      size_bytes: 4,
      page_count: 1,
      created_at: NOW,
      updated_at: NOW,
      generate_narration: false,
      pages: [{
        page_number: 1,
        scene_id: 'scene-slide',
        image: imageRelative,
        clip: `presentations/${PRESENTATION_ID}/clips/page-0001.mp4`,
        extracted_text: '',
        baseline: { name: 'Slide 1', description: '', narration_script: null },
        analysis_status: 'not-requested',
        script_status: 'not-requested',
      }],
    };
    await writeFile(path.join(bundle, 'manifest.json'), JSON.stringify(manifest));

    const response = await app.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/presentations/${PRESENTATION_ID}/pages/1/image`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'Presentation page image not found', code: 'not_found' });
  });

  it('opens the canonical image with no-follow semantics and rejects a post-validation symlink swap', async () => {
    const bundle = path.join(projectFiles(project.path).presentationsDir, PRESENTATION_ID);
    const imageRelative = `presentations/${PRESENTATION_ID}/pages/page-0001.png`;
    const imagePath = path.join(bundle, 'pages', 'page-0001.png');
    const outside = path.join(root, 'swap-target.png');
    await mkdir(path.dirname(imagePath), { recursive: true });
    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(outside, 'private outside bytes');
    const manifest: PresentationManifest = {
      schema_version: 1,
      id: PRESENTATION_ID,
      project_id: project.id,
      display_name: 'Slides.pdf',
      source_sha256: 'a'.repeat(64),
      size_bytes: 4,
      page_count: 1,
      created_at: NOW,
      updated_at: NOW,
      generate_narration: false,
      pages: [{
        page_number: 1,
        scene_id: 'scene-slide',
        image: imageRelative,
        clip: `presentations/${PRESENTATION_ID}/clips/page-0001.mp4`,
        extracted_text: '',
        baseline: { name: 'Slide 1', description: '', narration_script: null },
        analysis_status: 'not-requested',
        script_status: 'not-requested',
      }],
    };
    await writeFile(path.join(bundle, 'manifest.json'), JSON.stringify(manifest));
    const openFile: typeof open = vi.fn(async (target, flags) => {
      await rm(target);
      await symlink(outside, target);
      return open(target, flags);
    });
    const swapApp = Fastify({ logger: false });
    await swapApp.register(multipart);
    await registerPresentationRoutes(swapApp, {
      store,
      service: service as unknown as PresentationImportService,
      maxBytes: 32,
      drafter: drafter as unknown as PresentationNarrationDrafter,
      openFile,
    });

    try {
      const response = await swapApp.inject({
        method: 'GET',
        url: `/api/projects/${project.id}/presentations/${PRESENTATION_ID}/pages/1/image`,
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: 'Presentation page image not found', code: 'not_found' });
      expect(openFile).toHaveBeenCalledWith(
        expect.stringMatching(/page-0001\.png$/),
        expect.any(Number),
      );
      expect((openFile as ReturnType<typeof vi.fn>).mock.calls[0]![1] & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
      expect(response.body).not.toContain('swap-target.png');
      expect(response.body).not.toContain('private outside bytes');
    } finally {
      await swapApp.close();
    }
  });

  it('consumes detached processing rejection and logs only bounded identifiers and an error class', async () => {
    service.process.mockRejectedValueOnce(new Error(`/private/source.pdf Authorization: secret`));
    const warn = vi.spyOn(app.log, 'warn');
    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/presentations`,
      ...multipartPayload([{ kind: 'file', bytes: Buffer.from('%PDF route bytes') }]),
    });

    expect(response.statusCode).toBe(202);
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(warn).toHaveBeenCalledWith({
      projectId: project.id,
      presentationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      errorName: 'Error',
    }, 'Detached presentation processing failed');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('source.pdf');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
  });

  it('rejects page requests that name another presentation bundle', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/presentations/${SECOND_PRESENTATION_ID}/pages/1/image`,
    });
    expect(response.statusCode).toBe(404);
  });
});
