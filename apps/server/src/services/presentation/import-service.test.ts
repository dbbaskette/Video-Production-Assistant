import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { PdfInspection, PdfPageHandle } from './pdf.js';
import type { inspectPdf as InspectPdf } from './pdf.js';
import { PresentationPdfError } from './pdf.js';
import type { createSlideAssets as CreateSlideAssets } from './media.js';
import { PresentationJobStore } from './job-store.js';
import { PresentationImportService } from './import-service.js';
import { createStoryboard, loadStoryboard, mutateStoryboard, saveStoryboard } from '../storyboard/index.js';
import type { Project, Scene } from '@vpa/shared';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const PRESENTATION_ONE = '22222222-2222-4222-8222-222222222222';
const PRESENTATION_TWO = '33333333-3333-4333-8333-333333333333';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
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

  it('keeps a recoverable unreferenced final bundle when storyboard persistence fails', async () => {
    const presentationService = service({
      mutateStoryboard: async (projectRoot: string, transform: Parameters<typeof mutateStoryboard>[1]) => {
        await transform(await loadStoryboard(projectRoot));
        throw new Error('private storyboard disk failure');
      },
    });
    await stageAndRegister(presentationService);

    await expect(presentationService.process(project, PRESENTATION_ONE)).rejects.toMatchObject({
      code: 'storyboard_commit_failed',
      message: 'Presentation scenes could not be saved',
    });

    expect(await loadStoryboard(root)).toBeNull();
    await expect(access(path.join(root, 'presentations', PRESENTATION_ONE, 'manifest.json'))).resolves.toBeUndefined();
    await expect(access(path.join(root, '.presentation-staging', PRESENTATION_ONE, 'source.pdf'))).resolves.toBeUndefined();
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
});
