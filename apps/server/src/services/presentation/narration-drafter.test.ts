import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  PRESENTATION_NARRATION_PROMPT_VERSION,
  PRESENTATION_SLIDE_BRIEF_PROMPT_VERSION,
  PRESENTATION_SLIDE_BRIEF_SCHEMA_VERSION,
  PresentationDraftSchema,
  PresentationManifestSchema,
  type PresentationManifest,
  type PresentationSlideBrief,
  type Project,
  type Scene,
} from '@vpa/shared';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type {
  ModelRouter,
  ResolvedTextModel,
  ResolvedVisualModel,
} from '../llm/model-router.js';
import { createStoryboard, loadStoryboard, mutateStoryboard, saveStoryboard } from '../storyboard/index.js';
import { atomicWriteFile } from '../../lib/fs-atomic.js';
import { PresentationJobStore } from './job-store.js';
import type { SlideUnderstandingService } from './slide-understanding.js';
import {
  PresentationNarrationDrafter,
  MAX_WRITER_USER_PROMPT_BYTES,
  type PresentationNarrationDrafterOptions,
} from './narration-drafter.js';

const PRESENTATION_ID = '22222222-2222-4222-8222-222222222222';
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const NOW = '2026-08-05T12:00:00.000Z';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
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

function visualModel(): ResolvedVisualModel {
  return {
    apiKey: 'private-visual-key',
    model: 'gemini-2.5-pro',
    summary: {
      role: 'video-understanding',
      scope: 'global',
      entry_id: 'visual-entry',
      provider: 'gemini',
      model: 'gemini-2.5-pro',
      name: 'Gemini Visual',
      capabilities: { text: true, image: true, video: true },
      ready: true,
    },
  };
}

function writingModel(complete: ResolvedTextModel['client']['complete']): ResolvedTextModel {
  return {
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
  };
}

function brief(pageNumber: number): PresentationSlideBrief {
  return {
    schema_version: PRESENTATION_SLIDE_BRIEF_SCHEMA_VERSION,
    presentation_id: PRESENTATION_ID,
    page_number: pageNumber,
    image_sha256: sha256(`image-${pageNumber}`),
    extracted_text_sha256: sha256(`Extracted text ${pageNumber}`),
    model: { entry_id: 'visual-entry', provider: 'gemini', model: 'gemini-2.5-pro' },
    prompt_version: PRESENTATION_SLIDE_BRIEF_PROMPT_VERSION,
    visual_summary: `Validated visual summary ${pageNumber}`,
    detected_title: `Detected title ${pageNumber}`,
    key_points: [`Key point ${pageNumber}`],
    visual_elements: [`Diagram ${pageNumber}`],
    quantitative_claims: [`${pageNumber * 10}% visible`],
    uncertain_content: [`Do not claim secret ${pageNumber}`],
  };
}

describe('PresentationNarrationDrafter', () => {
  let root: string;
  let project: Project;
  let jobs: PresentationJobStore;
  let manifest: PresentationManifest;
  let scenes: Scene[];
  let resolveVisual: Mock<
    Parameters<ModelRouter['resolveVisual']>,
    ReturnType<ModelRouter['resolveVisual']>
  >;
  let resolveText: Mock<
    Parameters<ModelRouter['resolveText']>,
    ReturnType<ModelRouter['resolveText']>
  >;
  let ensureBrief: Mock<
    Parameters<SlideUnderstandingService['ensureBrief']>,
    ReturnType<SlideUnderstandingService['ensureBrief']>
  >;
  let complete: Mock<
    Parameters<ResolvedTextModel['client']['complete']>,
    ReturnType<ResolvedTextModel['client']['complete']>
  >;
  let warn: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), 'vpa-narration-drafter-')));
    project = {
      id: PROJECT_ID,
      name: 'presentation-project',
      path: root,
      created: NOW,
      objective: 'Explain the launch safely.',
      audience: 'Engineering leaders',
      brand: null,
      model_routing: {},
    };
    jobs = new PresentationJobStore({ warn: vi.fn() });
    scenes = [1, 2, 3].map((pageNumber) => ({
      id: `scene-${pageNumber}`,
      name: `Slide ${pageNumber}`,
      description: `Baseline description ${pageNumber}`,
      type: 'slide' as const,
      recording: {
        source: `presentations/${PRESENTATION_ID}/clips/page-${String(pageNumber).padStart(4, '0')}.mp4`,
        source_kind: 'presentation' as const,
        duration_sec: 1,
      },
      presentation_source: {
        presentation_id: PRESENTATION_ID,
        page_number: pageNumber,
        page_count: 3,
        image: `presentations/${PRESENTATION_ID}/pages/page-${String(pageNumber).padStart(4, '0')}.png`,
        hold_duration_sec: 5,
      },
    }));
    manifest = PresentationManifestSchema.parse({
      schema_version: 1,
      id: PRESENTATION_ID,
      project_id: PROJECT_ID,
      display_name: 'Launch.pdf',
      source_sha256: 'a'.repeat(64),
      size_bytes: 100,
      page_count: 3,
      created_at: NOW,
      updated_at: NOW,
      generate_narration: true,
      pages: scenes.map((scene, index) => ({
        page_number: index + 1,
        scene_id: scene.id,
        image: scene.presentation_source!.image,
        clip: scene.recording!.source,
        extracted_text: `Extracted text ${index + 1}`,
        baseline: {
          name: scene.name,
          description: scene.description,
          narration_script: null,
        },
        analysis_status: 'pending',
        script_status: 'pending',
      })),
    });
    const bundle = path.join(root, 'presentations', PRESENTATION_ID);
    await mkdir(path.join(bundle, 'pages'), { recursive: true });
    await mkdir(path.join(bundle, 'clips'), { recursive: true });
    await writeFile(path.join(bundle, 'manifest.json'), JSON.stringify(manifest));
    await Promise.all([1, 2, 3].flatMap((pageNumber) => [
      writeFile(path.join(bundle, 'pages', `page-${String(pageNumber).padStart(4, '0')}.png`), `image-${pageNumber}`),
      writeFile(path.join(bundle, 'clips', `page-${String(pageNumber).padStart(4, '0')}.mp4`), `clip-${pageNumber}`),
    ]));
    await saveStoryboard(root, createStoryboard(project, scenes));
    await jobs.create(root, {
      schema_version: 1,
      id: PRESENTATION_ID,
      project_id: PROJECT_ID,
      filename: 'Launch.pdf',
      status: 'processing',
      stage: 'drafting-narration',
      generate_narration: true,
      page_count: 3,
      processed_pages: 3,
      analyzed_pages: 0,
      scripted_pages: 0,
      remaining_scene_count: 3,
      deterministic_commit: 'committed',
      created_at: NOW,
      updated_at: NOW,
    });
    complete = vi.fn<
      Parameters<ResolvedTextModel['client']['complete']>,
      ReturnType<ResolvedTextModel['client']['complete']>
    >(async () => ({ text: 'Natural spoken narration.' }));
    resolveVisual = vi.fn<
      Parameters<ModelRouter['resolveVisual']>,
      ReturnType<ModelRouter['resolveVisual']>
    >(async () => visualModel());
    resolveText = vi.fn<
      Parameters<ModelRouter['resolveText']>,
      ReturnType<ModelRouter['resolveText']>
    >(async () => writingModel(complete));
    ensureBrief = vi.fn<
      Parameters<SlideUnderstandingService['ensureBrief']>,
      ReturnType<SlideUnderstandingService['ensureBrief']>
    >(async (input) => brief(input.pageNumber));
    warn = vi.fn();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function drafter(overrides: Partial<PresentationNarrationDrafterOptions> = {}) {
    return new PresentationNarrationDrafter({
      workspaceRoot: '/private/workspace-path',
      router: { resolveVisual, resolveText } as never,
      slideUnderstanding: { ensureBrief } as never,
      jobs,
      readPrompt: async () => 'Versioned narration system prompt.',
      now: () => NOW,
      warn,
      ...overrides,
    });
  }

  async function persistedManifest(): Promise<PresentationManifest> {
    return PresentationManifestSchema.parse(JSON.parse(await readFile(
      path.join(root, 'presentations', PRESENTATION_ID, 'manifest.json'),
      'utf8',
    )));
  }

  async function persistedDraft(pageNumber: number) {
    return PresentationDraftSchema.parse(JSON.parse(await readFile(
      path.join(
        root,
        'presentations',
        PRESENTATION_ID,
        'drafts',
        `page-${String(pageNumber).padStart(4, '0')}.json`,
      ),
      'utf8',
    )));
  }

  async function persistManifest(value: PresentationManifest): Promise<void> {
    manifest = PresentationManifestSchema.parse(value);
    await writeFile(
      path.join(root, 'presentations', PRESENTATION_ID, 'manifest.json'),
      JSON.stringify(manifest),
    );
  }

  async function persistDraft(pageNumber: number, value: unknown): Promise<void> {
    await writeFile(
      path.join(
        root,
        'presentations',
        PRESENTATION_ID,
        'drafts',
        `page-${String(pageNumber).padStart(4, '0')}.json`,
      ),
      JSON.stringify(PresentationDraftSchema.parse(value)),
    );
  }

  async function persistBriefs(): Promise<void> {
    const directory = path.join(root, 'presentations', PRESENTATION_ID, 'analysis');
    await mkdir(directory, { recursive: true });
    await Promise.all([1, 2, 3].map((pageNumber) => writeFile(
      path.join(directory, `page-${String(pageNumber).padStart(4, '0')}.json`),
      JSON.stringify(brief(pageNumber)),
    )));
  }

  async function makeJobRetryable(scriptedPages = 2): Promise<void> {
    await jobs.update(root, PRESENTATION_ID, {
      status: 'partial',
      stage: 'drafting-narration',
      scripted_pages: scriptedPages,
      error: {
        code: 'narration_incomplete',
        message: 'Presentation narration is incomplete',
      },
    });
  }

  it('resolves and validates both routed roles before starting any page or prompt work', async () => {
    const readPrompt = vi.fn(async () => 'must not be read');
    resolveVisual.mockRejectedValue(new Error('/private/model-provider-response'));
    resolveText.mockRejectedValue(new Error('writing key sk-secret'));

    const result = await drafter({ readPrompt }).run(project, PRESENTATION_ID);

    expect(resolveVisual).toHaveBeenCalledOnce();
    expect(resolveText).toHaveBeenCalledOnce();
    expect(ensureBrief).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(readPrompt).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: 'failed',
      stage: 'failed',
      error: {
        code: 'narration_model_routing_failed',
        message: 'Presentation narration model routing failed',
      },
    });
    expect(JSON.stringify(result)).not.toContain('/private');
    expect(JSON.stringify(result)).not.toContain('sk-secret');
  });

  it('finishes all bounded analysis before bounded writing and sends only the writer allowlist', async () => {
    const callOrder: string[] = [];
    let activeAnalysis = 0;
    let maxAnalysis = 0;
    let activeWriting = 0;
    let maxWriting = 0;
    const analysisGates = [deferred<void>(), deferred<void>(), deferred<void>()];
    const writingGates = [deferred<void>(), deferred<void>(), deferred<void>()];
    ensureBrief.mockImplementation(async (input) => {
      callOrder.push(`analyze:${input.pageNumber}`);
      activeAnalysis += 1;
      maxAnalysis = Math.max(maxAnalysis, activeAnalysis);
      await analysisGates[input.pageNumber - 1]!.promise;
      activeAnalysis -= 1;
      return brief(input.pageNumber);
    });
    complete.mockImplementation(async ({ userPrompt }) => {
      const payload = JSON.parse(userPrompt.slice(
        userPrompt.indexOf('{'),
        userPrompt.lastIndexOf('}') + 1,
      )) as Record<string, unknown>;
      const current = payload.current_slide as { page_number: number };
      callOrder.push(`write:${current.page_number}`);
      activeWriting += 1;
      maxWriting = Math.max(maxWriting, activeWriting);
      await writingGates[current.page_number - 1]!.promise;
      activeWriting -= 1;
      return { text: `Narration for page ${current.page_number}.` };
    });

    const running = drafter().run(project, PRESENTATION_ID);
    await vi.waitFor(() => expect(callOrder).toEqual(['analyze:1', 'analyze:2']));
    expect(complete).not.toHaveBeenCalled();
    analysisGates[0]!.resolve();
    await vi.waitFor(() => expect(callOrder).toContain('analyze:3'));
    expect(complete).not.toHaveBeenCalled();
    analysisGates[1]!.resolve();
    analysisGates[2]!.resolve();
    await vi.waitFor(() => expect(callOrder).toEqual([
      'analyze:1', 'analyze:2', 'analyze:3', 'write:1', 'write:2',
    ]));
    writingGates[0]!.resolve();
    await vi.waitFor(() => expect(callOrder).toContain('write:3'));
    writingGates[1]!.resolve();
    writingGates[2]!.resolve();

    const result = await running;

    expect(callOrder).toEqual([
      'analyze:1', 'analyze:2', 'analyze:3',
      'write:1', 'write:2', 'write:3',
    ]);
    expect(maxAnalysis).toBe(2);
    expect(maxWriting).toBe(2);
    expect(result).toMatchObject({ status: 'ready', stage: 'ready', scripted_pages: 3 });

    const firstRequest = complete.mock.calls[0]![0] as { systemPrompt: string; userPrompt: string };
    expect(firstRequest.systemPrompt).toBe('Versioned narration system prompt.');
    expect(firstRequest.userPrompt).not.toContain('private-visual-key');
    expect(firstRequest.userPrompt).not.toContain('/private');
    expect(firstRequest.userPrompt).not.toContain('data:image');
    expect(firstRequest.userPrompt).not.toContain('image_sha256');
    expect(firstRequest.userPrompt).not.toContain('provider');
    const payload = JSON.parse(firstRequest.userPrompt.slice(
      firstRequest.userPrompt.indexOf('{'),
      firstRequest.userPrompt.lastIndexOf('}') + 1,
    ));
    expect(payload).toEqual({
      project: { objective: 'Explain the launch safely.', audience: 'Engineering leaders' },
      current_slide: {
        page_number: 1,
        baseline_title: 'Slide 1',
        current_title: 'Slide 1',
        extracted_text: 'Extracted text 1',
        brief: {
          visual_summary: 'Validated visual summary 1',
          detected_title: 'Detected title 1',
          key_points: ['Key point 1'],
          visual_elements: ['Diagram 1'],
          quantitative_claims: ['10% visible'],
        },
      },
      neighbors: {
        previous: null,
        next: { title: 'Slide 2', validated_summary: 'Validated visual summary 2' },
      },
      prohibited_facts: { uncertain_content: ['Do not claim secret 1'] },
    });
    const saved = await loadStoryboard(root);
    expect(saved!.scenes[0]!.narration).toMatchObject({
      script: 'Narration for page 1.',
      monologueScript: 'Narration for page 1.',
      dialogDirty: true,
    });
    expect((await persistedDraft(1)).applied).toBe(true);
    expect((await persistedManifest()).pages.every((page) => page.script_status === 'ready')).toBe(true);
  }, 15_000);

  it('keeps successful pages when one analysis or writer page fails and retries only missing work', async () => {
    ensureBrief.mockImplementationOnce(async () => brief(1));
    ensureBrief.mockRejectedValueOnce(new Error('raw Gemini response must stay private'));
    ensureBrief.mockImplementationOnce(async () => brief(3));
    complete.mockImplementationOnce(async () => ({ text: 'Page one narration.' }));
    complete.mockRejectedValueOnce(new Error('writer provider body must stay private'));

    const first = await drafter().run(project, PRESENTATION_ID);

    expect(first).toMatchObject({ status: 'partial', stage: 'drafting-narration', scripted_pages: 1 });
    expect(JSON.stringify(first)).not.toContain('Gemini');
    expect(JSON.stringify(first)).not.toContain('provider body');
    expect((await persistedManifest()).pages.map((page) => [page.analysis_status, page.script_status])).toEqual([
      ['ready', 'ready'],
      ['failed', 'failed'],
      ['ready', 'failed'],
    ]);

    ensureBrief.mockClear();
    complete.mockClear();
    ensureBrief.mockImplementation(async (input) => brief(input.pageNumber));
    complete.mockImplementation(async () => ({ text: 'Recovered narration.' }));
    const retried = await drafter().retry(project, PRESENTATION_ID);

    expect(retried).toMatchObject({ status: 'ready', stage: 'ready', scripted_pages: 3 });
    expect(ensureBrief.mock.calls.map(([input]) => (input as { pageNumber: number }).pageNumber)).toEqual([2, 3]);
    expect(complete).toHaveBeenCalledTimes(2);
    expect((await persistedDraft(1)).script).toBe('Page one narration.');
  });

  it('hydrates ready neighbor briefs so an exact page-two draft keeps its original fingerprint and reconciles without models', async () => {
    await drafter().run(project, PRESENTATION_ID);
    await persistBriefs();
    const original = await persistedDraft(2);
    await persistDraft(2, { ...original, applied: false });
    const current = await persistedManifest();
    await persistManifest({
      ...current,
      pages: current.pages.map((page) => page.page_number === 2
        ? { ...page, script_status: 'failed' }
        : page),
    });
    await makeJobRetryable();
    ensureBrief.mockClear();
    complete.mockClear();

    const result = await drafter().retry(project, PRESENTATION_ID);

    expect(result).toMatchObject({ status: 'ready', scripted_pages: 3 });
    expect(ensureBrief).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect((await persistedDraft(2))).toMatchObject({
      brief_fingerprint: original.brief_fingerprint,
      applied: true,
    });
  });

  it('gives a true page-two writer retry validated page-one and page-three neighbors without reanalyzing them', async () => {
    await drafter().run(project, PRESENTATION_ID);
    await persistBriefs();
    await rm(path.join(root, 'presentations', PRESENTATION_ID, 'drafts', 'page-0002.json'));
    await mutateStoryboard(root, (current) => ({
      ...current!,
      scenes: current!.scenes.map((scene) => scene.id === 'scene-2'
        ? { ...scene, narration: undefined }
        : scene),
    }));
    const current = await persistedManifest();
    await persistManifest({
      ...current,
      pages: current.pages.map((page) => page.page_number === 2
        ? { ...page, script_status: 'failed', draft: undefined }
        : page),
    });
    await makeJobRetryable();
    ensureBrief.mockClear();
    complete.mockClear();
    complete.mockResolvedValue({ text: 'Recovered page two narration.' });

    const result = await drafter().retry(project, PRESENTATION_ID);

    expect(result).toMatchObject({ status: 'ready', scripted_pages: 3 });
    expect(ensureBrief).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledOnce();
    const userPrompt = complete.mock.calls[0]![0].userPrompt;
    const payload = JSON.parse(userPrompt.slice(userPrompt.indexOf('{'), userPrompt.lastIndexOf('}') + 1));
    expect(payload.neighbors).toEqual({
      previous: { title: 'Detected title 1', validated_summary: 'Validated visual summary 1' },
      next: { title: 'Detected title 3', validated_summary: 'Validated visual summary 3' },
    });
  });

  it('sends latest current and neighbor storyboard titles without truncation or detected-title substitution', async () => {
    const currentTitle = `Current user title ${'x'.repeat(220)}`;
    const neighborTitle = `Neighbor user title ${'y'.repeat(220)}`;
    await mutateStoryboard(root, (current) => ({
      ...current!,
      scenes: current!.scenes.map((scene, index) => {
        if (index === 0) return { ...scene, name: currentTitle };
        if (index === 1) return { ...scene, name: neighborTitle };
        return scene;
      }),
    }));

    await drafter().run(project, PRESENTATION_ID);

    const userPrompt = complete.mock.calls[0]![0].userPrompt;
    const payload = JSON.parse(userPrompt.slice(userPrompt.indexOf('{'), userPrompt.lastIndexOf('}') + 1));
    expect(payload.current_slide.current_title).toBe(currentTitle);
    expect(payload.neighbors.next.title).toBe(neighborTitle);
    expect(payload.current_slide.brief.detected_title).toBe('Detected title 1');
  });

  it('repairs a fresh cached brief marker before writing and derives exact analyzed counters', async () => {
    await persistBriefs();
    const current = await persistedManifest();
    await persistManifest({
      ...current,
      pages: current.pages.map((page) => page.page_number === 2
        ? { ...page, analysis_status: 'failed', brief: undefined }
        : {
          ...page,
          analysis_status: 'ready',
          brief: `presentations/${PRESENTATION_ID}/analysis/page-${String(page.page_number).padStart(4, '0')}.json`,
        }),
    });
    ensureBrief.mockClear();

    const result = await drafter().retry(project, PRESENTATION_ID);

    expect(ensureBrief).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: 'ready',
      stage: 'ready',
      analyzed_pages: 3,
      scripted_pages: 3,
    });
    expect((await persistedManifest()).pages[1]).toMatchObject({
      analysis_status: 'ready',
      brief: `presentations/${PRESENTATION_ID}/analysis/page-0002.json`,
      script_status: 'ready',
    });
  });

  it('preserves name, description, and narration independently against the latest storyboard', async () => {
    const modelGate = deferred<void>();
    complete.mockImplementation(async () => {
      await modelGate.promise;
      return { text: 'Generated draft stays reviewable.' };
    });
    const running = drafter().run(project, PRESENTATION_ID);
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2));
    await mutateStoryboard(root, (current) => ({
      ...current!,
      scenes: current!.scenes.map((scene, index) => {
        if (index === 0) return { ...scene, name: 'User name' };
        if (index === 1) return { ...scene, description: 'User description' };
        if (index === 2) {
          return {
            ...scene,
            narration: {
              script: 'User script',
              monologueScript: 'User script',
              dialogScript: '[Speaker A] User dialog',
              mode: 'dialog',
              audio: 'narration/user.mp3',
              tts: { engine: 'kept', voice: 'kept' },
            },
          };
        }
        return scene;
      }),
    }));
    modelGate.resolve();

    const result = await running;
    const saved = await loadStoryboard(root);

    expect(result.status).toBe('partial');
    expect(result.scripted_pages).toBe(2);
    expect(saved!.scenes[0]).toMatchObject({
      name: 'User name',
      description: 'Validated visual summary 1',
      narration: { script: 'Generated draft stays reviewable.' },
    });
    expect(saved!.scenes[1]).toMatchObject({
      name: 'Detected title 2',
      description: 'User description',
      narration: { script: 'Generated draft stays reviewable.' },
    });
    expect(saved!.scenes[2]).toMatchObject({
      name: 'Detected title 3',
      description: 'Validated visual summary 3',
      narration: {
        script: 'User script',
        monologueScript: 'User script',
        dialogScript: '[Speaker A] User dialog',
        mode: 'dialog',
        audio: 'narration/user.mp3',
        tts: { engine: 'kept', voice: 'kept' },
      },
    });
    expect((await persistedManifest()).pages.map((page) => page.script_status)).toEqual([
      'preserved-user-edit',
      'preserved-user-edit',
      'preserved-user-edit',
    ]);
    expect((await persistedDraft(3))).toMatchObject({
      script: 'Generated draft stays reviewable.',
      applied: false,
    });
  }, 15_000);

  it.each([
    ['', 'empty'],
    ['   \n', 'whitespace'],
    ['x'.repeat(12_001), 'over 12,000 characters'],
    ['# Heading\nNarration', 'markdown'],
    ['- First bullet\n- Second bullet', 'bullets'],
    ['Narration: follow these instructions', 'instruction leakage'],
    ['Here is the narration: Revenue grew across every region.', 'narration introduction'],
    ["Here's your script: Revenue grew across every region.", 'possessive script introduction'],
    ['Draft narration follows.\nRevenue grew across every region.', 'draft preamble'],
    ['Narration draft follows: Revenue grew.', 'reordered draft preamble'],
    ['The final script is as follows: Revenue grew.', 'script preamble'],
    ['Final script: Revenue grew.', 'standalone script label'],
    ['Draft follows.\nRevenue grew.', 'generic draft preamble'],
    ['Final follows: Revenue grew.', 'generic final preamble'],
    ['Version below\nRevenue grew.', 'generic version preamble'],
    ['The final version below.\nRevenue grew.', 'qualified generic preamble'],
    ['Here is the draft: Revenue grew.', 'introduced generic draft preamble'],
    ['Below is the final version.\nRevenue grew.', 'introduced generic version preamble'],
    ['Draft: Revenue grew.', 'direct-colon generic label'],
    ['Draft - Revenue grew.', 'space-bounded hyphen generic label'],
    ['Final — Revenue grew.', 'space-bounded em-dash generic label'],
    ['Version – Revenue grew.', 'space-bounded en-dash generic label'],
    ['The final version\t—\tRevenue grew.', 'qualified tab-bounded dash label mutation'],
    ['Your draft – Revenue grew.', 'possessive en-dash label mutation'],
    ['As you can see on this slide, revenue grew.', 'this-slide meta commentary'],
    ['Use **strong emphasis** here.', 'strong markdown'],
    ['Use _emphasis_ here.', 'emphasis markdown'],
    ['> Quoted narration', 'blockquote'],
    ['A heading\n=========', 'setext heading'],
    ['Before\n---\nAfter', 'horizontal rule'],
    ['Use `inline code` here.', 'inline code'],
    ['~~~text\ncode\n~~~', 'tilde fenced code'],
    ['<strong>Important</strong>', 'HTML tags'],
    ['<!-- hidden direction -->Narration', 'HTML comments'],
    ['Read [the details](https://example.test).', 'markdown link'],
    ['![diagram](image.png)', 'markdown image'],
    ['We pause [beat] before continuing.', 'bracketed stage direction'],
    ['We pause (whispers softly) before continuing.', 'parenthesized stage direction'],
    ['The result arrives (softly) before the close.', 'terse parenthesized stage direction'],
    ['(fade in) Revenue grew across every region.', 'fade production direction'],
    ['Revenue grew. (music starts)', 'complete music production direction'],
    ['(cut to demo)\nRevenue grew.', 'line-leading cut production direction'],
    ['Revenue grew. (transition to chart)', 'transition production direction'],
    ['(show dashboard) Revenue grew.', 'line-leading show production direction'],
    ['(display chart) Revenue grew.', 'line-leading display production direction'],
    ['(zoom in on chart) Revenue grew.', 'line-leading zoom production direction'],
    ['(pause) Revenue grew.', 'line-leading pause production direction'],
    ['(beat) Revenue grew.', 'line-leading beat production direction'],
    ['Revenue grew. [music fades out]', 'music production cue'],
    ['Revenue grew. [show demo]', 'bracketed show production cue'],
  ])('rejects %s writer output before storyboard apply (%s)', async (text) => {
    complete.mockResolvedValue({ text });

    const result = await drafter().run(project, PRESENTATION_ID);

    expect(result).toMatchObject({ status: 'partial', scripted_pages: 0 });
    const saved = await loadStoryboard(root);
    expect(saved!.scenes.every((scene) => scene.narration === undefined)).toBe(true);
    await expect(persistedDraft(1)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    'Revenue grew across Europe (including Germany and France) while costs stayed flat.',
    'The script follows a clear arc from customer need to measurable results.',
    'Demand faded in the second quarter (especially in Europe) before recovering.',
    'The program expanded into new fields (music and culture) this year.',
    'The components were cut to size (cut to fit before shipping).',
    'The release remains on schedule (transition planning continues) this quarter.',
    'The final version below market expectations still improved retention.',
    'Our draft follows the evidence gathered from customer interviews.',
    'Version-control improvements reduce deployment risk.',
    'Final-stage testing begins tomorrow.',
    'Draft-proof windows reduce energy costs.',
  ])('accepts ordinary spoken prose without production directions: %s', async (text) => {
    complete.mockResolvedValue({ text });

    const result = await drafter().run(project, PRESENTATION_ID);

    expect(result).toMatchObject({ status: 'ready', scripted_pages: 3 });
  });

  it('measures the final escaped UTF-8 writer request and performs zero provider calls when it overflows', async () => {
    const escapedMultibyte = `${'é'.repeat(700)}${'"\\'.repeat(150)}`;
    ensureBrief.mockImplementation(async (input) => ({
      ...brief(input.pageNumber),
      visual_summary: '"'.repeat(4_000),
      detected_title: '"'.repeat(200),
      key_points: Array.from({ length: 50 }, () => escapedMultibyte),
      visual_elements: Array.from({ length: 50 }, () => escapedMultibyte),
      quantitative_claims: Array.from({ length: 50 }, (_, index) => `${index}: ${escapedMultibyte}`.slice(0, 1_000)),
      uncertain_content: Array.from({ length: 50 }, () => escapedMultibyte),
    }));

    const result = await drafter().run(project, PRESENTATION_ID);

    expect(MAX_WRITER_USER_PROMPT_BYTES).toBeGreaterThan(0);
    expect(result).toMatchObject({ status: 'partial', scripted_pages: 0 });
    expect(complete).not.toHaveBeenCalled();
  });

  it('keeps required factual fields byte-exact in a normal payload below the aggregate limit', async () => {
    ensureBrief.mockImplementation(async (input) => ({
      ...brief(input.pageNumber),
      quantitative_claims: ['Revenue was exactly 18% — $4.2M "reported".'],
    }));

    await drafter().run(project, PRESENTATION_ID);

    const request = complete.mock.calls[0]![0].userPrompt;
    expect(Buffer.byteLength(request, 'utf8')).toBeLessThanOrEqual(MAX_WRITER_USER_PROMPT_BYTES);
    const payload = JSON.parse(request.slice(request.indexOf('{'), request.lastIndexOf('}') + 1));
    expect(payload.current_slide.brief.quantitative_claims).toEqual([
      'Revenue was exactly 18% — $4.2M "reported".',
    ]);
    expect(payload.current_slide.extracted_text).toBe('Extracted text 1');
  });

  it('fails missing or mismatched provenance safely and never applies a page draft to another scene', async () => {
    await mutateStoryboard(root, (current) => ({
      ...current!,
      scenes: [
        { ...current!.scenes[0]!, presentation_source: undefined, recording: undefined },
        current!.scenes[2]!,
        current!.scenes[1]!,
      ],
    }));

    const result = await drafter().run(project, PRESENTATION_ID);
    const saved = await loadStoryboard(root);

    expect(result.status).toBe('partial');
    expect(ensureBrief).toHaveBeenCalledTimes(2);
    expect(saved!.scenes.find((scene) => scene.id === 'scene-1')!.narration).toBeUndefined();
    expect(saved!.scenes.find((scene) => scene.id === 'scene-2')!.narration?.script).toBe('Natural spoken narration.');
    expect(saved!.scenes.find((scene) => scene.id === 'scene-3')!.narration?.script).toBe('Natural spoken narration.');
  });

  it('deduplicates automatic start and retry and reconciles an already-applied draft without writing again', async () => {
    const gate = deferred<void>();
    complete.mockImplementation(async () => {
      await gate.promise;
      return { text: 'Idempotent narration.' };
    });
    const service = drafter();
    const first = service.run(project, PRESENTATION_ID);
    const duplicate = service.retry(project, PRESENTATION_ID);
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2));
    gate.resolve();
    const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);

    expect(duplicateResult).toEqual(firstResult);
    expect(complete).toHaveBeenCalledTimes(3);
    ensureBrief.mockClear();
    complete.mockClear();
    const rerun = await service.run(project, PRESENTATION_ID);
    expect(rerun.status).toBe('ready');
    expect(ensureBrief).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it('stops after a lifecycle tombstone appears while a model is running', async () => {
    const gate = deferred<void>();
    ensureBrief.mockImplementation(async (input) => {
      await gate.promise;
      return brief(input.pageNumber);
    });
    const running = drafter().run(project, PRESENTATION_ID);
    await vi.waitFor(() => expect(ensureBrief).toHaveBeenCalledTimes(2));
    await jobs.update(root, PRESENTATION_ID, { deletion_pending: true });
    gate.resolve();

    await running;

    expect(complete).not.toHaveBeenCalled();
    const saved = await loadStoryboard(root);
    expect(saved!.scenes.every((scene) => scene.narration === undefined)).toBe(true);
  });

  it('does not mark a draft applied when the queued storyboard save fails', async () => {
    const failingMutation: typeof mutateStoryboard = async () => {
      throw new Error('/private/storyboard.yaml save failed');
    };

    const result = await drafter({ mutateStoryboard: failingMutation }).run(project, PRESENTATION_ID);

    expect(result).toMatchObject({ status: 'partial', scripted_pages: 0 });
    expect(JSON.stringify(result)).not.toContain('/private');
    expect((await persistedDraft(1)).applied).toBe(false);
    expect((await persistedManifest()).pages.every((page) => page.script_status === 'failed')).toBe(true);
  });

  it('leaves a committed non-narration job and manifest unchanged after an eligibility failure', async () => {
    const currentManifest = await persistedManifest();
    const nonNarrationManifest = { ...currentManifest, generate_narration: false };
    await persistManifest(nonNarrationManifest);
    const ready = await jobs.update(root, PRESENTATION_ID, {
      status: 'ready',
      stage: 'ready',
      generate_narration: false,
      analyzed_pages: 0,
      scripted_pages: 0,
      error: undefined,
    });

    const result = await drafter().retry(project, PRESENTATION_ID);

    expect(result).toEqual(ready);
    expect(await jobs.read(root, PRESENTATION_ID)).toEqual(ready);
    expect(await persistedManifest()).toEqual(nonNarrationManifest);
    expect(resolveVisual).not.toHaveBeenCalled();
    expect(resolveText).not.toHaveBeenCalled();
    expect(ensureBrief).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it('persists a bounded retryable partial job when initial manifest persistence fails', async () => {
    const result = await drafter({
      writeContainedFile: async () => {
        throw new Error('/private/bundle/manifest.json raw persistence failure');
      },
    }).run(project, PRESENTATION_ID);

    expect(result).toMatchObject({
      status: 'partial',
      stage: 'drafting-narration',
      error: {
        code: 'narration_operational_failure',
        message: 'Presentation narration encountered an operational failure',
      },
    });
    expect(ensureBrief).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('/private');
  });

  it('persists a bounded retryable partial job when the storyboard cannot be read', async () => {
    const result = await drafter({
      loadStoryboard: async () => {
        throw new Error('/private/project/storyboard.yaml is unreadable');
      },
    }).run(project, PRESENTATION_ID);

    expect(result).toMatchObject({
      status: 'partial',
      stage: 'drafting-narration',
      error: { code: 'narration_operational_failure' },
    });
    expect(ensureBrief).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('/private');
  });

  it('surfaces bounded uncertainty when operational failure status persistence also fails', async () => {
    const failingJobs = new PresentationJobStore({
      warn: vi.fn(),
      persist: async (target, data) => {
        if (data.includes('narration_operational_failure')) {
          throw new Error('/private/presentation-jobs/provider-body');
        }
        await atomicWriteFile(target, data);
      },
    });

    await expect(drafter({
      jobs: failingJobs,
      loadStoryboard: async () => {
        throw new Error('/private/storyboard failure');
      },
    }).run(project, PRESENTATION_ID)).rejects.toMatchObject({
      code: 'presentation_narration_failed',
    });
    expect(await failingJobs.read(root, PRESENTATION_ID)).toMatchObject({
      status: 'processing',
      stage: 'drafting-narration',
    });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorName: 'Error', presentationId: PRESENTATION_ID }),
      'Presentation narration failure status could not be persisted',
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('/private');
  });

  it('reconciles an exact storyboard script when the post-save draft marker was not persisted', async () => {
    const failingMutation: typeof mutateStoryboard = async () => {
      throw new Error('save failed before the test simulates a committed storyboard');
    };
    await drafter({ mutateStoryboard: failingMutation }).run(project, PRESENTATION_ID);
    const drafts = await Promise.all([1, 2, 3].map((pageNumber) => persistedDraft(pageNumber)));
    await mutateStoryboard(root, (current) => ({
      ...current!,
      scenes: current!.scenes.map((scene, index) => ({
        ...scene,
        narration: {
          script: drafts[index]!.script,
          monologueScript: drafts[index]!.script,
          dialogDirty: true,
        },
      })),
    }));
    ensureBrief.mockClear();
    complete.mockClear();

    const result = await drafter().retry(project, PRESENTATION_ID);

    expect(result).toMatchObject({ status: 'ready', scripted_pages: 3 });
    expect(ensureBrief).toHaveBeenCalledTimes(3);
    expect(complete).not.toHaveBeenCalled();
    expect((await persistedDraft(1)).applied).toBe(true);
  });

  it('includes the prompt version and routed writer identity in persisted draft freshness', async () => {
    await drafter().run(project, PRESENTATION_ID);

    const draft = await persistedDraft(1);
    expect(draft.model).toEqual({ entry_id: 'writer-entry', model: 'writer-v1' });
    expect(draft.brief_fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(PRESENTATION_NARRATION_PROMPT_VERSION).toBe(1);
  });
});
