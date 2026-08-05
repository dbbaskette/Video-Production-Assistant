import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import FormData from 'form-data';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PresentationJob, PresentationManifest, Project } from '@vpa/shared';
import { ProjectStore } from '../services/project/store.js';
import type { PresentationImportService } from '../services/presentation/import-service.js';
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
    remove: Mock<Parameters<PresentationImportService['remove']>, ReturnType<PresentationImportService['remove']>>;
  };

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'vpa-presentation-routes-'));
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
      remove: vi.fn<Parameters<PresentationImportService['remove']>, ReturnType<PresentationImportService['remove']>>(async () => undefined),
    };
    app = Fastify({ logger: false });
    await app.register(multipart);
    await registerPresentationRoutes(app, {
      store,
      service: service as unknown as PresentationImportService,
      maxBytes: 32,
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

  it('returns 501 for retry-narration until a callback is injected', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/presentations/${PRESENTATION_ID}/retry-narration`,
    });

    expect(response.statusCode).toBe(501);
    expect(response.json()).toEqual({
      error: 'Presentation narration is not available',
      code: 'narration_not_implemented',
    });
  });

  it('returns a retry-narration job through the optional callback', async () => {
    const retryNarration = vi.fn(async () => job({ project_id: project.id, stage: 'drafting-narration' }));
    const callbackApp = Fastify({ logger: false });
    await callbackApp.register(multipart);
    await registerPresentationRoutes(callbackApp, {
      store,
      service: service as unknown as PresentationImportService,
      maxBytes: 32,
      retryNarration,
    });
    try {
      const response = await callbackApp.inject({
        method: 'POST',
        url: `/api/projects/${project.id}/presentations/${PRESENTATION_ID}/retry-narration`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ id: PRESENTATION_ID, stage: 'drafting-narration' });
      expect(retryNarration).toHaveBeenCalledWith(project, PRESENTATION_ID);
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
