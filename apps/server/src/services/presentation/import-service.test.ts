import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { PdfInspection, PdfPageHandle } from './pdf.js';
import type { inspectPdf as InspectPdf } from './pdf.js';
import { PresentationPdfError } from './pdf.js';
import type { createSlideAssets as CreateSlideAssets } from './media.js';
import { PresentationJobStore } from './job-store.js';
import { PresentationImportService } from './import-service.js';
import { createStoryboard, loadStoryboard, mutateStoryboard, removeScene, saveStoryboard } from '../storyboard/index.js';
import type { PresentationJob, PresentationManifest, Project, Scene } from '@vpa/shared';
import { atomicWriteFile } from '../../lib/fs-atomic.js';
import { projectFiles } from '../project/paths.js';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const PRESENTATION_ONE = '22222222-2222-4222-8222-222222222222';
const PRESENTATION_TWO = '33333333-3333-4333-8333-333333333333';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitForSignalOrTurn(signal: Promise<void>): Promise<void> {
  await Promise.race([
    signal,
    new Promise<void>((resolve) => setTimeout(resolve, 100)),
  ]);
}

function inspection(headings: Array<string | undefined>, texts?: string[]): PdfInspection {
  const pages: PdfPageHandle[] = headings.map((heading, index) => ({
    pageNumber: index + 1,
    width: 1280,
    height: 720,
    rotation: 0,
    text: texts?.[index] ?? `Extracted text for page ${index + 1}`,
    heading,
    render: async (destination) => {
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, `raw-page-${index + 1}`);
    },
  }));
  return { pageCount: pages.length, pages, close: vi.fn(async () => undefined) };
}

describe('PresentationImportService', () => {
  let root: string;
  let project: Project;
  let jobs: PresentationJobStore;
  let warn: ReturnType<typeof vi.fn>;
  let inspect: Mock<Parameters<typeof InspectPdf>, ReturnType<typeof InspectPdf>>;
  let createAssets: Mock<Parameters<typeof CreateSlideAssets>, ReturnType<typeof CreateSlideAssets>>;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'vpa-presentation-import-'));
    project = {
      id: PROJECT_ID,
      name: 'presentation-test',
      path: root,
      created: '2026-08-05T12:00:00.000Z',
      brand: null,
      model_routing: {},
    };
    warn = vi.fn();
    jobs = new PresentationJobStore({ warn });
    inspect = vi.fn<Parameters<typeof InspectPdf>, ReturnType<typeof InspectPdf>>(
      async () => inspection([' Opening ', '   ', 'Closing']),
    );
    createAssets = vi.fn<Parameters<typeof CreateSlideAssets>, ReturnType<typeof CreateSlideAssets>>(async ({ rawPagePath, imagePath, clipPath }) => {
      await access(rawPagePath);
      await mkdir(path.dirname(imagePath), { recursive: true });
      await mkdir(path.dirname(clipPath), { recursive: true });
      await writeFile(imagePath, 'normalized-image');
      await writeFile(clipPath, 'one-second-clip');
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function service(overrides: Record<string, unknown> = {}) {
    return new PresentationImportService({
      jobs,
      maxPages: 200,
      inspectPdf: inspect,
      createSlideAssets: createAssets,
      warn,
      ...overrides,
    });
  }

  async function stageAndRegister(
    presentationService: PresentationImportService,
    id = PRESENTATION_ONE,
    bytes = '%PDF deterministic bytes',
    generateNarration = false,
  ) {
    const source = path.join(root, '.presentation-staging', id, 'source.pdf');
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, bytes);
    return presentationService.registerUpload({
      project,
      id,
      filename: '../Quarterly Review.pdf',
      stagedSourcePath: source,
      sizeBytes: Buffer.byteLength(bytes),
      generateNarration,
    });
  }

  async function createPersistedJob(
    id: string,
    overrides: Partial<PresentationJob> = {},
  ): Promise<PresentationJob> {
    return jobs.create(root, {
      schema_version: 1,
      id,
      project_id: project.id,
      filename: 'Recovered.pdf',
      status: 'processing',
      stage: 'creating-scenes',
      generate_narration: false,
      page_count: 1,
      processed_pages: 1,
      analyzed_pages: 0,
      scripted_pages: 0,
      remaining_scene_count: 0,
      created_at: '2026-08-05T12:00:00.000Z',
      updated_at: '2026-08-05T12:00:00.000Z',
      ...overrides,
    });
  }

  async function writeCompleteBundle(
    id: string,
    overrides: Partial<PresentationManifest> = {},
  ): Promise<PresentationManifest> {
    const bundle = path.join(projectFiles(root).presentationsDir, id);
    const image = `presentations/${id}/pages/page-0001.png`;
    const clip = `presentations/${id}/clips/page-0001.mp4`;
    const manifest: PresentationManifest = {
      schema_version: 1,
      id,
      project_id: project.id,
      display_name: 'Recovered.pdf',
      source_sha256: 'a'.repeat(64),
      size_bytes: 20,
      page_count: 1,
      created_at: '2026-08-05T12:00:00.000Z',
      updated_at: '2026-08-05T12:00:00.000Z',
      generate_narration: false,
      pages: [{
        page_number: 1,
        scene_id: `scene-${id.slice(0, 8)}`,
        image,
        clip,
        extracted_text: 'Recovered text',
        baseline: { name: 'Recovered slide', description: 'Recovered text', narration_script: null },
        analysis_status: 'not-requested',
        script_status: 'not-requested',
      }],
      ...overrides,
    };
    await mkdir(path.join(bundle, 'pages'), { recursive: true });
    await mkdir(path.join(bundle, 'clips'), { recursive: true });
    await writeFile(path.join(bundle, 'source.pdf'), '%PDF recovered');
    await writeFile(path.join(bundle, 'pages', 'page-0001.png'), 'png');
    await writeFile(path.join(bundle, 'clips', 'page-0001.mp4'), 'mp4');
    await writeFile(path.join(bundle, 'manifest.json'), JSON.stringify(manifest));
    return manifest;
  }

  function sceneForManifest(manifest: PresentationManifest): Scene {
    const page = manifest.pages[0]!;
    return {
      id: page.scene_id,
      name: 'User-renamed slide',
      description: 'User-authored description',
      type: 'slide',
      recording: { source: page.clip, source_kind: 'presentation', duration_sec: 1 },
      presentation_source: {
        presentation_id: manifest.id,
        page_number: page.page_number,
        page_count: manifest.page_count,
        image: page.image,
        hold_duration_sec: 12,
      },
      narration: { script: 'User-authored narration must survive.' },
    };
  }

  it('imports three ordered slide scenes after existing scenes with deterministic paths and names', async () => {
    const existing: Scene = { id: 'scene-existing', name: 'Existing', description: 'Keep first', type: 'desktop' };
    await saveStoryboard(root, createStoryboard(project, [existing]));
    const presentationService = service();
    await stageAndRegister(presentationService);

    const result = await presentationService.process(project, PRESENTATION_ONE);

    expect(result).toMatchObject({ status: 'ready', stage: 'ready', page_count: 3, processed_pages: 3 });
    const storyboard = await loadStoryboard(root);
    expect(storyboard?.scenes.map(({ type }) => type)).toEqual(['desktop', 'slide', 'slide', 'slide']);
    expect(storyboard?.scenes.slice(1).map(({ name }) => name)).toEqual(['Opening', 'Slide 2', 'Closing']);
    expect(storyboard?.scenes[1]).toMatchObject({
      recording: {
        source: `presentations/${PRESENTATION_ONE}/clips/page-0001.mp4`,
        source_kind: 'presentation',
        duration_sec: 1,
      },
      presentation_source: {
        presentation_id: PRESENTATION_ONE,
        page_number: 1,
        page_count: 3,
        image: `presentations/${PRESENTATION_ONE}/pages/page-0001.png`,
        hold_duration_sec: 5,
      },
    });
    const manifest = JSON.parse(await readFile(path.join(root, 'presentations', PRESENTATION_ONE, 'manifest.json'), 'utf8'));
    expect(manifest.display_name).toBe('Quarterly Review.pdf');
    expect(manifest.pages.map((page: { page_number: number }) => page.page_number)).toEqual([1, 2, 3]);
    await expect(access(path.join(root, '.presentation-staging', PRESENTATION_ONE))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('creates a new storyboard when the project has none and marks narration work pending', async () => {
    inspect.mockResolvedValueOnce(inspection(['Narrated slide']));
    const presentationService = service();
    await stageAndRegister(presentationService, PRESENTATION_ONE, '%PDF narration', true);

    const result = await presentationService.process(project, PRESENTATION_ONE);

    expect(result).toMatchObject({ status: 'processing', stage: 'drafting-narration' });
    expect((await loadStoryboard(root))?.project.id).toBe(PROJECT_ID);
    expect((await loadStoryboard(root))?.scenes).toHaveLength(1);
  });

  it('commits zero scenes and removes partial page work after a media failure', async () => {
    const existing = createStoryboard(project, [{ id: 'scene-existing', name: 'Existing', description: '', type: 'desktop' }]);
    await saveStoryboard(root, existing);
    createAssets.mockImplementationOnce(async ({ imagePath }) => {
      await mkdir(path.dirname(imagePath), { recursive: true });
      await writeFile(imagePath, 'partial');
      throw new Error('private ffmpeg failure');
    });
    const presentationService = service();
    await stageAndRegister(presentationService);

    await expect(presentationService.process(project, PRESENTATION_ONE)).rejects.toMatchObject({
      code: 'processing_failed',
      message: 'Presentation processing failed',
    });

    expect(await loadStoryboard(root)).toEqual(existing);
    expect(await readdir(path.join(root, '.presentation-staging', PRESENTATION_ONE))).toEqual(['source.pdf']);
    await expect(access(path.join(root, 'presentations', PRESENTATION_ONE))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await jobs.read(root, PRESENTATION_ONE))?.status).toBe('failed');
  });

  it('rejects an incomplete bundle immediately before storyboard append', async () => {
    inspect.mockResolvedValueOnce(inspection(['Missing clip']));
    createAssets.mockImplementationOnce(async ({ imagePath }) => {
      await mkdir(path.dirname(imagePath), { recursive: true });
      await writeFile(imagePath, 'image-without-clip');
    });
    const presentationService = service();
    await stageAndRegister(presentationService);

    await expect(presentationService.process(project, PRESENTATION_ONE)).rejects.toMatchObject({
      code: 'processing_failed',
    });

    expect(await loadStoryboard(root)).toBeNull();
    await expect(access(path.join(root, 'presentations', PRESENTATION_ONE))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(path.join(root, '.presentation-staging', PRESENTATION_ONE))).toEqual(['source.pdf']);
  });

  it('honors durable job cancellation immediately before move and append', async () => {
    inspect.mockResolvedValueOnce(inspection(['Cancelled slide']));
    let manifestWrites = 0;
    const presentationService = service({
      persist: async (target: string, data: string) => {
        await atomicWriteFile(target, data);
        manifestWrites += 1;
        if (manifestWrites === 1) {
          await jobs.update(root, PRESENTATION_ONE, {
            status: 'failed',
            stage: 'failed',
            error: { code: 'cancelled', message: 'Import cancelled' },
          });
        }
      },
    });
    await stageAndRegister(presentationService);

    await expect(presentationService.process(project, PRESENTATION_ONE)).rejects.toMatchObject({
      code: 'invalid_import_state',
    });

    expect(await jobs.read(root, PRESENTATION_ONE)).toMatchObject({ status: 'failed', stage: 'failed' });
    expect(await loadStoryboard(root)).toBeNull();
    await expect(access(path.join(root, 'presentations', PRESENTATION_ONE))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps a recoverable unreferenced final bundle when the real queued storyboard save fails', async () => {
    const snapshotWarning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const presentationService = service({
      moveFiles: async (source: string, destination: string) => {
        await rename(source, destination);
        await chmod(root, 0o500);
      },
    });
    await stageAndRegister(presentationService);

    try {
      await expect(presentationService.process(project, PRESENTATION_ONE)).rejects.toMatchObject({
        code: 'storyboard_commit_failed',
        message: 'Presentation scenes could not be saved',
      });
    } finally {
      await chmod(root, 0o700);
      snapshotWarning.mockRestore();
    }

    expect(await loadStoryboard(root)).toBeNull();
    await expect(access(path.join(root, 'presentations', PRESENTATION_ONE, 'manifest.json'))).resolves.toBeUndefined();
    await expect(access(path.join(root, '.presentation-staging', PRESENTATION_ONE, 'source.pdf'))).resolves.toBeUndefined();
  });

  it('serializes removal behind in-flight processing without deleting its source or bundle', async () => {
    const mediaEntered = deferred();
    const releaseMedia = deferred();
    const deleteEntered = deferred();
    inspect.mockResolvedValueOnce(inspection(['Lifecycle slide']));
    createAssets.mockImplementationOnce(async ({ imagePath, clipPath }) => {
      mediaEntered.resolve();
      await releaseMedia.promise;
      await mkdir(path.dirname(imagePath), { recursive: true });
      await mkdir(path.dirname(clipPath), { recursive: true });
      await writeFile(imagePath, 'image');
      await writeFile(clipPath, 'clip');
    });
    const realDelete = jobs.delete.bind(jobs);
    vi.spyOn(jobs, 'delete').mockImplementation(async (...args) => {
      deleteEntered.resolve();
      return realDelete(...args);
    });
    const presentationService = service();
    await stageAndRegister(presentationService);
    const processing = presentationService.process(project, PRESENTATION_ONE);
    await mediaEntered.promise;

    const removal = presentationService.remove(project, PRESENTATION_ONE);
    await waitForSignalOrTurn(deleteEntered.promise);
    releaseMedia.resolve();

    await expect(processing).resolves.toMatchObject({ status: 'ready' });
    await expect(removal).resolves.toBeUndefined();
    expect(await presentationService.get(root, PRESENTATION_ONE)).toBeNull();
    expect((await loadStoryboard(root))?.scenes).toEqual([]);
    await expect(access(path.join(root, 'presentations', PRESENTATION_ONE))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('serializes duplicate process calls before expensive page work', async () => {
    const mediaEntered = deferred();
    const releaseMedia = deferred();
    let mediaRuns = 0;
    inspect.mockImplementation(async () => inspection(['Single run']));
    createAssets.mockImplementation(async ({ imagePath, clipPath }) => {
      mediaRuns += 1;
      mediaEntered.resolve();
      await releaseMedia.promise;
      await mkdir(path.dirname(imagePath), { recursive: true });
      await mkdir(path.dirname(clipPath), { recursive: true });
      await writeFile(imagePath, 'image');
      await writeFile(clipPath, 'clip');
    });
    const presentationService = service();
    await stageAndRegister(presentationService);

    const first = presentationService.process(project, PRESENTATION_ONE);
    await mediaEntered.promise;
    const duplicate = presentationService.process(project, PRESENTATION_ONE);
    const duplicateResult = expect(duplicate).rejects.toMatchObject({ code: 'invalid_import_state' });
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    releaseMedia.resolve();

    await expect(first).resolves.toMatchObject({ status: 'ready' });
    await duplicateResult;
    expect(mediaRuns).toBe(1);
    expect((await loadStoryboard(root))?.scenes).toHaveLength(1);
  });

  it('does not downgrade committed scenes when the terminal job write fails', async () => {
    const terminalJobs = new PresentationJobStore({
      warn,
      persist: async (target, data) => {
        const record = JSON.parse(data) as { stage?: string };
        if (record.stage === 'ready') throw new Error('private terminal job write failure');
        await atomicWriteFile(target, data);
      },
    });
    inspect.mockResolvedValueOnce(inspection(['Committed slide']));
    const presentationService = service({ jobs: terminalJobs });
    await stageAndRegister(presentationService);

    await expect(presentationService.process(project, PRESENTATION_ONE)).rejects.toMatchObject({
      code: 'committed_state_pending',
      message: 'Presentation scenes were saved; status reconciliation is pending',
    });

    expect((await loadStoryboard(root))?.scenes).toHaveLength(1);
    expect(await terminalJobs.read(root, PRESENTATION_ONE)).toMatchObject({
      status: 'processing',
      stage: 'creating-scenes',
    });
    await expect(access(path.join(root, 'presentations', PRESENTATION_ONE, 'manifest.json'))).resolves.toBeUndefined();
    await expect(access(path.join(root, '.presentation-staging', PRESENTATION_ONE, 'source.pdf'))).resolves.toBeUndefined();
  });

  it('keeps the committed terminal job ready when the post-commit manifest refresh fails', async () => {
    let manifestWrites = 0;
    inspect.mockResolvedValueOnce(inspection(['Committed slide']));
    const presentationService = service({
      persist: async (target: string, data: string) => {
        manifestWrites += 1;
        if (manifestWrites === 2) throw new Error('private manifest refresh failure');
        await atomicWriteFile(target, data);
      },
    });
    await stageAndRegister(presentationService);

    await expect(presentationService.process(project, PRESENTATION_ONE)).resolves.toMatchObject({
      status: 'ready',
      stage: 'ready',
    });
    expect((await loadStoryboard(root))?.scenes).toHaveLength(1);
    expect(await jobs.read(root, PRESENTATION_ONE)).toMatchObject({ status: 'ready', stage: 'ready' });
  });

  it('keeps exact remaining scene counts after individual scene deletion', async () => {
    const presentationService = service();
    await stageAndRegister(presentationService);
    await presentationService.process(project, PRESENTATION_ONE);
    const imported = (await loadStoryboard(root))!.scenes;
    await mutateStoryboard(root, (current) => removeScene(current!, imported[1]!.id));

    expect(await presentationService.get(root, PRESENTATION_ONE)).toMatchObject({ remaining_scene_count: 2 });
    expect(await presentationService.list(root)).toEqual([
      expect.objectContaining({ id: PRESENTATION_ONE, remaining_scene_count: 2 }),
    ]);
  });

  it('uses a neutral bounded description for blank image-only slides', async () => {
    inspect.mockResolvedValueOnce(inspection([undefined], ['   ']));
    const presentationService = service();
    await stageAndRegister(presentationService);

    await presentationService.process(project, PRESENTATION_ONE);

    expect((await loadStoryboard(root))?.scenes[0]?.description).toBe(
      'Presentation slide awaiting visual analysis.',
    );
    const manifest = JSON.parse(
      await readFile(path.join(root, 'presentations', PRESENTATION_ONE, 'manifest.json'), 'utf8'),
    ) as { pages: Array<{ baseline: { description: string } }> };
    expect(manifest.pages[0]?.baseline.description).toBe('Presentation slide awaiting visual analysis.');
  });

  it('preserves a concurrent storyboard edit when appending scenes', async () => {
    const mediaEntered = deferred();
    const releaseMedia = deferred();
    createAssets.mockImplementationOnce(async ({ imagePath, clipPath }) => {
      mediaEntered.resolve();
      await releaseMedia.promise;
      await mkdir(path.dirname(imagePath), { recursive: true });
      await mkdir(path.dirname(clipPath), { recursive: true });
      await writeFile(imagePath, 'image');
      await writeFile(clipPath, 'clip');
    });
    inspect.mockResolvedValueOnce(inspection(['Only slide']));
    const presentationService = service();
    await stageAndRegister(presentationService);
    const processing = presentationService.process(project, PRESENTATION_ONE);
    await mediaEntered.promise;

    await mutateStoryboard(root, (current) => {
      const base = current ?? createStoryboard(project, []);
      return { ...base, scenes: [...base.scenes, { id: 'scene-user', name: 'User edit', description: '', type: 'desktop' }] };
    });
    releaseMedia.resolve();
    await processing;

    expect((await loadStoryboard(root))?.scenes.map(({ id }) => id)).toEqual([
      'scene-user',
      expect.stringMatching(/^scene-[0-9a-f]{8}$/),
    ]);
  });

  it('retries only a retained valid source and maps invalid retained bytes to source_not_available', async () => {
    createAssets.mockRejectedValueOnce(new Error('transient media failure'));
    const presentationService = service();
    await stageAndRegister(presentationService);
    await expect(presentationService.process(project, PRESENTATION_ONE)).rejects.toMatchObject({ code: 'processing_failed' });

    await expect(presentationService.retryImport(project, PRESENTATION_ONE)).resolves.toMatchObject({ status: 'ready' });

    const secondService = service();
    await stageAndRegister(secondService, PRESENTATION_TWO, '%PDF retained then corrupt');
    createAssets.mockRejectedValueOnce(new Error('transient media failure'));
    await expect(secondService.process(project, PRESENTATION_TWO)).rejects.toMatchObject({ code: 'processing_failed' });
    inspect.mockRejectedValueOnce(new PresentationPdfError('invalid_pdf', 'private parser detail'));
    await expect(secondService.retryImport(project, PRESENTATION_TWO)).rejects.toMatchObject({
      code: 'source_not_available',
      message: 'The original PDF is not available for retry',
    });
  });

  it('imports identical bytes under independent presentation UUIDs', async () => {
    inspect.mockImplementation(async () => inspection(['Same deck']));
    const presentationService = service();
    await stageAndRegister(presentationService, PRESENTATION_ONE, '%PDF identical');
    await presentationService.process(project, PRESENTATION_ONE);
    await stageAndRegister(presentationService, PRESENTATION_TWO, '%PDF identical');
    await presentationService.process(project, PRESENTATION_TWO);

    const storyboard = await loadStoryboard(root);
    expect(storyboard?.scenes.map((scene) => scene.presentation_source?.presentation_id)).toEqual([
      PRESENTATION_ONE,
      PRESENTATION_TWO,
    ]);
    const firstManifest = JSON.parse(await readFile(path.join(root, 'presentations', PRESENTATION_ONE, 'manifest.json'), 'utf8'));
    const secondManifest = JSON.parse(await readFile(path.join(root, 'presentations', PRESENTATION_TWO, 'manifest.json'), 'utf8'));
    expect(firstManifest.source_sha256).toBe(secondManifest.source_sha256);
  });

  it('removes matching scenes before assets and warns without restoring scenes when asset deletion fails', async () => {
    inspect.mockResolvedValueOnce(inspection(['Remove me']));
    const presentationService = service();
    await stageAndRegister(presentationService);
    await presentationService.process(project, PRESENTATION_ONE);
    let sceneCountAtAssetDeletion: number | undefined;
    const failingRemove = service({
      removeFiles: vi.fn(async (target: string) => {
        if (target.includes('/presentations/')) {
          sceneCountAtAssetDeletion = (await loadStoryboard(root))?.scenes.length;
          throw new Error('private deletion path');
        }
        await rm(target, { recursive: true, force: true });
      }),
    });

    await failingRemove.remove(project, PRESENTATION_ONE);

    expect((await loadStoryboard(root))?.scenes).toEqual([]);
    expect(sceneCountAtAssetDeletion).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      { errorName: 'PresentationAssetDeletionError', presentationId: PRESENTATION_ONE },
      'Presentation assets could not be fully removed',
    );
  });

  it('reconciles a committed creating-scenes job before interrupted-state handling and preserves user work', async () => {
    const manifest = await writeCompleteBundle(PRESENTATION_ONE);
    await createPersistedJob(PRESENTATION_ONE);
    const authoredScene = sceneForManifest(manifest);
    await saveStoryboard(root, createStoryboard(project, [authoredScene]));
    const presentationService = service();

    await presentationService.reconcile([project]);
    await presentationService.reconcile([project]);

    const reconciled = await jobs.read(root, PRESENTATION_ONE);
    expect(reconciled).toMatchObject({
      status: 'ready',
      stage: 'ready',
      page_count: 1,
      processed_pages: 1,
      remaining_scene_count: 1,
    });
    expect(reconciled).not.toHaveProperty('error');
    expect((await loadStoryboard(root))?.scenes).toEqual([authoredScene]);
    await expect(access(path.join(root, 'presentations', PRESENTATION_ONE, 'source.pdf'))).resolves.toBeUndefined();
    expect(inspect).not.toHaveBeenCalled();
    expect(createAssets).not.toHaveBeenCalled();
  });

  it('advances a committed narration import and invokes only the narration restart callback', async () => {
    const manifest = await writeCompleteBundle(PRESENTATION_ONE, {
      generate_narration: true,
      pages: [{
        page_number: 1,
        scene_id: 'scene-narration',
        image: `presentations/${PRESENTATION_ONE}/pages/page-0001.png`,
        clip: `presentations/${PRESENTATION_ONE}/clips/page-0001.mp4`,
        extracted_text: 'Narration text',
        baseline: { name: 'Narration', description: 'Narration text', narration_script: null },
        analysis_status: 'pending',
        script_status: 'pending',
      }],
    });
    await createPersistedJob(PRESENTATION_ONE, { generate_narration: true });
    await saveStoryboard(root, createStoryboard(project, [sceneForManifest(manifest)]));
    const presentationService = service();

    await presentationService.reconcile([project]);
    expect(await jobs.read(root, PRESENTATION_ONE)).toMatchObject({
      status: 'processing',
      stage: 'drafting-narration',
    });

    const retryNarration = vi.fn(async (_project: Project, id: string) => jobs.update(root, id, {
      status: 'ready',
      stage: 'ready',
    }));
    await presentationService.reconcile([project], retryNarration);
    await presentationService.reconcile([project], retryNarration);

    expect(retryNarration).toHaveBeenCalledTimes(1);
    expect(await jobs.read(root, PRESENTATION_ONE)).toMatchObject({ status: 'ready', stage: 'ready' });
    expect(inspect).not.toHaveBeenCalled();
    expect(createAssets).not.toHaveBeenCalled();
  });

  it('marks only truly uncommitted deterministic stages as interrupted and keeps retained sources retryable', async () => {
    const ids = [PRESENTATION_ONE, PRESENTATION_TWO, '44444444-4444-4444-8444-444444444444'];
    const stages = ['uploading', 'processing-slides', 'creating-scenes'] as const;
    for (let index = 0; index < ids.length; index += 1) {
      const id = ids[index]!;
      await createPersistedJob(id, {
        stage: stages[index],
        page_count: stages[index] === 'uploading' ? 0 : 1,
        processed_pages: stages[index] === 'creating-scenes' ? 1 : 0,
      });
      const staging = path.join(root, '.presentation-staging', id);
      await mkdir(staging, { recursive: true });
      await writeFile(path.join(staging, 'source.pdf'), '%PDF retained');
    }

    await service().reconcile([project]);

    for (const id of ids) {
      expect(await jobs.read(root, id)).toMatchObject({
        status: 'failed',
        stage: 'failed',
        error: {
          code: 'interrupted_import',
          message: 'Presentation import was interrupted; retry the import',
        },
      });
      await expect(access(path.join(root, '.presentation-staging', id, 'source.pdf'))).resolves.toBeUndefined();
    }
    expect(inspect).not.toHaveBeenCalled();
  });

  it('removes orphan staging and only unreferenced never-committed final bundles', async () => {
    const orphanStagingId = '44444444-4444-4444-8444-444444444444';
    await mkdir(path.join(root, '.presentation-staging', orphanStagingId), { recursive: true });
    await writeFile(path.join(root, '.presentation-staging', orphanStagingId, 'source.pdf'), 'orphan');

    await writeCompleteBundle(PRESENTATION_ONE);
    await createPersistedJob(PRESENTATION_ONE, {
      status: 'failed',
      stage: 'failed',
      error: { code: 'interrupted_import', message: 'Interrupted' },
    });
    await writeCompleteBundle(PRESENTATION_TWO);
    await createPersistedJob(PRESENTATION_TWO, { status: 'ready', stage: 'ready' });

    await service().reconcile([project]);

    await expect(access(path.join(root, '.presentation-staging', orphanStagingId))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(path.join(root, 'presentations', PRESENTATION_ONE))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(path.join(root, 'presentations', PRESENTATION_TWO, 'manifest.json'))).resolves.toBeUndefined();
  });

  it('never deletes a final bundle whose validated manifest scene is live in the storyboard', async () => {
    const manifest = await writeCompleteBundle(PRESENTATION_ONE);
    await createPersistedJob(PRESENTATION_ONE, {
      status: 'failed',
      stage: 'failed',
      error: { code: 'processing_failed', message: 'Earlier failure' },
    });
    await saveStoryboard(root, createStoryboard(project, [sceneForManifest(manifest)]));

    await service().reconcile([project]);

    await expect(access(path.join(root, 'presentations', PRESENTATION_ONE, 'manifest.json'))).resolves.toBeUndefined();
    expect((await loadStoryboard(root))?.scenes[0]?.name).toBe('User-renamed slide');
  });

  it('preserves a final bundle whenever a validated manifest scene id still appears in the storyboard', async () => {
    const manifest = await writeCompleteBundle(PRESENTATION_ONE);
    await createPersistedJob(PRESENTATION_ONE, {
      status: 'failed',
      stage: 'failed',
      error: { code: 'processing_failed', message: 'Earlier failure' },
    });
    await saveStoryboard(root, createStoryboard(project, [{
      id: manifest.pages[0]!.scene_id,
      name: 'User repurposed scene',
      description: 'The manifest scene id remains live.',
      type: 'desktop',
    }]));

    await service().reconcile([project]);

    await expect(access(path.join(root, 'presentations', PRESENTATION_ONE, 'manifest.json'))).resolves.toBeUndefined();
  });

  it('isolates malformed job and project state while reconciling other safe jobs', async () => {
    await mkdir(projectFiles(root).presentationJobsDir, { recursive: true });
    await writeFile(
      path.join(projectFiles(root).presentationJobsDir, `${PRESENTATION_ONE}.json`),
      '{"private_path":"/Users/secret/source.pdf"}',
    );
    await createPersistedJob(PRESENTATION_TWO, {
      stage: 'processing-slides',
      page_count: 0,
      processed_pages: 0,
    });

    const malformedRoot = path.join(root, 'malformed-project');
    const malformedProject: Project = {
      ...project,
      id: '55555555-5555-4555-8555-555555555555',
      path: malformedRoot,
      name: 'malformed',
    };
    await mkdir(malformedRoot, { recursive: true });
    await writeFile(path.join(malformedRoot, 'storyboard.yaml'), 'scenes: [private: /Users/secret');

    await service().reconcile([malformedProject, project]);

    expect(await jobs.read(root, PRESENTATION_TWO)).toMatchObject({
      status: 'failed',
      error: { code: 'interrupted_import' },
    });
    expect(warn).toHaveBeenCalledWith(
      { errorName: 'InvalidPresentationJobRecord', jobId: PRESENTATION_ONE },
      'Ignored invalid presentation job record',
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('/Users/secret');
  });
});
