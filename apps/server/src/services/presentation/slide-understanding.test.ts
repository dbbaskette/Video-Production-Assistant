import { createHash } from 'node:crypto';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  PRESENTATION_SLIDE_BRIEF_PROMPT_VERSION,
  PRESENTATION_SLIDE_BRIEF_SCHEMA_VERSION,
  PresentationSlideBriefSchema,
} from '@vpa/shared';
import { afterEach, beforeEach, describe, expect, it, vi, type MockedFunction } from 'vitest';
import type { ResolvedVisualModel } from '../llm/model-router.js';
import {
  inspectContainedFilesystemResources,
  resetContainedFilesystemMetricsForTests,
} from './contained-filesystem.js';
import {
  MAX_INLINE_IMAGE_BYTES,
  type GenerateWithImageInput,
  type GeminiImageTransportLike,
} from './gemini-image.js';
import {
  inspectSlideUnderstandingResources,
  SlideUnderstandingError,
  SlideUnderstandingService,
  type EnsureSlideBriefInput,
  type SlideUnderstandingServiceOptions,
} from './slide-understanding.js';

const PRESENTATION_ID = '11111111-1111-4111-8111-111111111111';
const ORIGINAL_IMAGE = Buffer.from('immutable normalized PNG bytes');
const EXTRACTED_TEXT = 'Revenue increased 18% to $4.2M.';

const validModelOutput = JSON.stringify({
  visual_summary: 'A revenue chart rises from Q1 through Q4.',
  detected_title: 'Annual revenue',
  key_points: ['Revenue increased throughout the year.'],
  visual_elements: ['A blue line chart with four quarterly labels.'],
  quantitative_claims: ['Revenue increased 18% to $4.2M.'],
  uncertain_content: [],
});

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function model(entryId = 'visual-entry', concreteModel = 'gemini-2.5-pro'): ResolvedVisualModel {
  return {
    apiKey: 'private-api-key',
    model: concreteModel,
    summary: {
      role: 'video-understanding',
      scope: 'global',
      entry_id: entryId,
      provider: 'gemini',
      model: concreteModel,
      name: 'Gemini Visual',
      capabilities: { text: true, image: true, video: true },
      ready: true,
    },
  };
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

describe('SlideUnderstandingService', () => {
  let projectPath: string;
  let imagePath: string;
  let input: EnsureSlideBriefInput;
  let warn: ReturnType<typeof vi.fn>;
  let generateWithImage: MockedFunction<GeminiImageTransportLike['generateWithImage']>;

  beforeEach(async () => {
    projectPath = await realpath(await mkdtemp(path.join(tmpdir(), 'vpa-slide-understanding-')));
    imagePath = path.join(projectPath, 'presentations', PRESENTATION_ID, 'pages', 'page-0001.png');
    await mkdir(path.dirname(imagePath), { recursive: true });
    await writeFile(imagePath, ORIGINAL_IMAGE);
    input = {
      projectPath,
      presentationId: PRESENTATION_ID,
      pageNumber: 1,
      imagePath,
      extractedText: EXTRACTED_TEXT,
    };
    warn = vi.fn();
    generateWithImage = vi.fn(
      async (_request: GenerateWithImageInput) => validModelOutput,
    ) as MockedFunction<GeminiImageTransportLike['generateWithImage']>;
  });

  afterEach(async () => {
    await rm(projectPath, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function service(overrides: Partial<SlideUnderstandingServiceOptions> = {}) {
    return new SlideUnderstandingService({
      workspaceRoot: '/private/workspace-that-must-not-leak',
      transport: { generateWithImage } as GeminiImageTransportLike,
      readPrompt: async () => 'Exact versioned visual prompt.',
      warn,
      ...overrides,
    });
  }

  function artifactPath(pageNumber = 1): string {
    return path.join(
      projectPath,
      'presentations',
      PRESENTATION_ID,
      'analysis',
      `page-${String(pageNumber).padStart(4, '0')}.json`,
    );
  }

  it('generates a server-owned strict artifact with exact source hashes and routed model provenance', async () => {
    const brief = await service().ensureBrief(input, model());

    expect(brief).toEqual({
      schema_version: PRESENTATION_SLIDE_BRIEF_SCHEMA_VERSION,
      presentation_id: PRESENTATION_ID,
      page_number: 1,
      image_sha256: sha256(ORIGINAL_IMAGE),
      extracted_text_sha256: sha256(EXTRACTED_TEXT),
      model: {
        entry_id: 'visual-entry',
        provider: 'gemini',
        model: 'gemini-2.5-pro',
      },
      prompt_version: PRESENTATION_SLIDE_BRIEF_PROMPT_VERSION,
      ...JSON.parse(validModelOutput),
    });
    const persisted = JSON.parse(await readFile(artifactPath(), 'utf8'));
    expect(PresentationSlideBriefSchema.parse(persisted)).toEqual(brief);
    expect(Object.keys(persisted).sort()).toEqual(
      [
        'detected_title',
        'extracted_text_sha256',
        'image_sha256',
        'key_points',
        'model',
        'page_number',
        'presentation_id',
        'prompt_version',
        'quantitative_claims',
        'schema_version',
        'uncertain_content',
        'visual_elements',
        'visual_summary',
      ].sort(),
    );
    expect(generateWithImage).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'private-api-key',
        model: 'gemini-2.5-pro',
        systemPrompt: 'Exact versioned visual prompt.',
        imageMimeType: 'image/png',
        responseMimeType: 'application/json',
        maxTokens: 4_096,
        expectedImageSha256: sha256(ORIGINAL_IMAGE),
      }),
    );
    const request = generateWithImage.mock.calls[0]![0] as GenerateWithImageInput;
    expect(request.userPrompt).toContain('Analyze slide 1.');
    expect(request.userPrompt).toContain(EXTRACTED_TEXT);
    expect(request.imageBytes).toEqual(ORIGINAL_IMAGE);
    expect(request.imagePath).toBeUndefined();
    expect((await readdir(path.dirname(artifactPath()))).sort()).toEqual(['page-0001.json']);
    expect((await stat(path.dirname(artifactPath()))).mode & 0o777).toBe(0o700);
    expect((await stat(artifactPath())).mode & 0o777).toBe(0o600);
  });

  it.each([
    ['plain JSON', validModelOutput],
    ['JSON fenced once', `\n\`\`\`json\n${validModelOutput}\n\`\`\`\n`],
    ['unlabelled JSON fenced once', `\`\`\`\n${validModelOutput}\n\`\`\``],
  ])('accepts %s', async (_label, output) => {
    generateWithImage.mockResolvedValueOnce(output);

    await expect(service().ensureBrief(input, model())).resolves.toMatchObject({
      visual_summary: 'A revenue chart rises from Q1 through Q4.',
    });
  });

  it.each([
    ['trailing text', `${validModelOutput} private trailing text`],
    ['multiple objects', `${validModelOutput}${validModelOutput}`],
    ['an unclosed fence', `\`\`\`json\n${validModelOutput}`],
    ['text outside a fence', `private prefix\n\`\`\`json\n${validModelOutput}\n\`\`\``],
    ['extra key', JSON.stringify({ ...JSON.parse(validModelOutput), speaker_notes: 'invented' })],
    [
      'missing key',
      JSON.stringify({
        visual_summary: 'A revenue chart rises from Q1 through Q4.',
        key_points: ['Revenue increased throughout the year.'],
        visual_elements: ['A blue line chart with four quarterly labels.'],
        quantitative_claims: ['Revenue increased 18% to $4.2M.'],
        uncertain_content: [],
      }),
    ],
    ['wrong type', JSON.stringify({ ...JSON.parse(validModelOutput), key_points: 'not an array' })],
    [
      'too many list items',
      JSON.stringify({ ...JSON.parse(validModelOutput), key_points: Array(51).fill('point') }),
    ],
    [
      'an oversized list item',
      JSON.stringify({ ...JSON.parse(validModelOutput), key_points: ['x'.repeat(1_001)] }),
    ],
    ['an empty list item', JSON.stringify({ ...JSON.parse(validModelOutput), key_points: [''] })],
    [
      'a whitespace visual summary',
      JSON.stringify({ ...JSON.parse(validModelOutput), visual_summary: '   ' }),
    ],
    [
      'a whitespace list item',
      JSON.stringify({ ...JSON.parse(validModelOutput), key_points: [' \t '] }),
    ],
  ])('rejects and does not persist %s', async (_label, output) => {
    generateWithImage.mockResolvedValueOnce(output);

    await expect(service().ensureBrief(input, model())).rejects.toEqual(
      new SlideUnderstandingError(),
    );

    await expect(access(artifactPath())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reuses an exactly fresh cache entry with zero transport and prompt calls', async () => {
    const readPrompt = vi.fn(async () => 'Exact versioned visual prompt.');
    const instance = service({ readPrompt });
    const first = await instance.ensureBrief(input, model());
    generateWithImage.mockClear();
    readPrompt.mockClear();
    resetContainedFilesystemMetricsForTests();

    const second = await instance.ensureBrief(input, model());

    expect(second).toEqual(first);
    expect(generateWithImage).not.toHaveBeenCalled();
    expect(readPrompt).not.toHaveBeenCalled();
    expect(inspectContainedFilesystemResources()).toMatchObject({
      activePermits: 0,
      activeProcesses: 0,
      queued: 0,
      spawned: 2,
    });
  });

  it('caches one bounded validated system prompt across cache-invalidating generations', async () => {
    const readPrompt = vi.fn(async () => 'Exact versioned visual prompt.');
    const instance = service({ readPrompt });

    await instance.ensureBrief(input, model());
    await instance.ensureBrief({ ...input, extractedText: `${EXTRACTED_TEXT} updated` }, model());

    expect(generateWithImage).toHaveBeenCalledTimes(2);
    expect(readPrompt).toHaveBeenCalledOnce();
  });

  it('invalidates independently on image bytes, exact extracted text, model entry, and concrete model', async () => {
    const instance = service();
    await instance.ensureBrief(input, model());
    await writeFile(imagePath, Buffer.from('changed image bytes'));
    const changedImage = await instance.ensureBrief(input, model());
    const changedText = await instance.ensureBrief(
      { ...input, extractedText: `${EXTRACTED_TEXT} ` },
      model(),
    );
    const changedEntry = await instance.ensureBrief(input, model('visual-entry-next'));
    const changedConcrete = await instance.ensureBrief(
      input,
      model('visual-entry-next', 'gemini-3-pro'),
    );

    expect(generateWithImage).toHaveBeenCalledTimes(5);
    expect(changedImage.image_sha256).toBe(sha256('changed image bytes'));
    expect(changedText.extracted_text_sha256).toBe(sha256(`${EXTRACTED_TEXT} `));
    expect(changedEntry.model.entry_id).toBe('visual-entry-next');
    expect(changedConcrete.model.model).toBe('gemini-3-pro');
  });

  it.each(['schema_version', 'prompt_version'] as const)(
    'invalidates a cache with a stale %s',
    async (field) => {
      const instance = service();
      await instance.ensureBrief(input, model());
      const stale = JSON.parse(await readFile(artifactPath(), 'utf8'));
      await writeFile(artifactPath(), JSON.stringify({ ...stale, [field]: 999 }));

      await instance.ensureBrief(input, model());

      expect(generateWithImage).toHaveBeenCalledTimes(2);
    },
  );

  it('regenerates malformed and unreadable cache records with identifier-only diagnostics', async () => {
    await mkdir(path.dirname(artifactPath()), { recursive: true });
    await writeFile(artifactPath(), '{ private malformed model JSON');
    await service().ensureBrief(input, model());
    expect(warn).toHaveBeenCalledWith(
      { errorName: 'InvalidSlideBriefCache', presentationId: PRESENTATION_ID, pageNumber: 1 },
      'Regenerating invalid slide brief cache',
    );

    warn.mockClear();
    generateWithImage.mockClear();
    const unreadable = service({
      readTextFile: async () => {
        throw Object.assign(new Error('private cache path and contents'), { code: 'EACCES' });
      },
    });
    await unreadable.ensureBrief(input, model('another-entry'));
    expect(generateWithImage).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      { errorName: 'UnreadableSlideBriefCache', presentationId: PRESENTATION_ID, pageNumber: 1 },
      'Regenerating unreadable slide brief cache',
    );
  });

  it('deduplicates concurrent work for the same complete freshness key', async () => {
    const gate = deferred<string>();
    generateWithImage.mockImplementation(() => gate.promise);
    const instance = service();
    resetContainedFilesystemMetricsForTests();

    const first = instance.ensureBrief(input, model());
    const second = instance.ensureBrief(input, model());
    await vi.waitFor(() => expect(generateWithImage).toHaveBeenCalledOnce());
    expect(inspectContainedFilesystemResources()).toMatchObject({
      activePermits: 0,
      activeProcesses: 0,
      queued: 0,
      spawned: 3,
    });
    gate.resolve(validModelOutput);

    const [one, two] = await Promise.all([first, second]);
    expect(two).toEqual(one);
  });

  it('does not deduplicate different pages, models, or image hashes', async () => {
    const secondImage = path.join(path.dirname(imagePath), 'page-0002.png');
    await writeFile(secondImage, Buffer.from('page two image'));
    const gates = [deferred<string>(), deferred<string>(), deferred<string>()];
    generateWithImage.mockImplementation(
      () => gates[generateWithImage.mock.calls.length - 1]!.promise,
    );
    const instance = service();

    const calls = [
      instance.ensureBrief(input, model()),
      instance.ensureBrief({ ...input, pageNumber: 2, imagePath: secondImage }, model()),
      instance.ensureBrief(input, model('different-entry')),
    ];
    await vi.waitFor(() => expect(generateWithImage).toHaveBeenCalledTimes(3));
    gates.forEach((gate) => gate.resolve(validModelOutput));

    await expect(Promise.all(calls)).resolves.toHaveLength(3);
  });

  it('removes a rejected in-flight tail so a later retry can run', async () => {
    generateWithImage
      .mockRejectedValueOnce(new Error('private provider response'))
      .mockResolvedValueOnce(validModelOutput);
    const instance = service();

    await expect(instance.ensureBrief(input, model())).rejects.toEqual(
      new SlideUnderstandingError(),
    );
    expect(inspectSlideUnderstandingResources(instance)).toEqual({ inFlight: 0, targets: 0 });
    await expect(instance.ensureBrief(input, model())).resolves.toMatchObject({ page_number: 1 });

    expect(generateWithImage).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['invalid UUID', { presentationId: '../private' }],
    ['zero page', { pageNumber: 0 }],
    ['excess page', { pageNumber: 201 }],
    ['wrong image path', { imagePath: '/private/not-the-canonical-page.png' }],
    ['oversized extracted text', { extractedText: 'x'.repeat(20_001) }],
  ])('rejects %s before transport', async (_label, override) => {
    await expect(service().ensureBrief({ ...input, ...override }, model())).rejects.toEqual(
      new SlideUnderstandingError(),
    );
    expect(generateWithImage).not.toHaveBeenCalled();
  });

  it('fails safe when the canonical image is a symlink', async () => {
    const outside = path.join(projectPath, 'private-outside.png');
    await writeFile(outside, Buffer.from('private outside image'));
    await rm(imagePath);
    await symlink(outside, imagePath);

    await expect(service().ensureBrief(input, model())).rejects.toEqual(
      new SlideUnderstandingError(),
    );

    expect(generateWithImage).not.toHaveBeenCalled();
  });

  it('hashes and sends the same captured bytes when the source changes during generation', async () => {
    let sentBytes: Buffer | undefined;
    generateWithImage.mockImplementation(async (request: GenerateWithImageInput) => {
      sentBytes = Buffer.from(request.imageBytes!);
      await writeFile(imagePath, Buffer.from('replacement after snapshot'));
      return validModelOutput;
    });

    const brief = await service().ensureBrief(input, model());

    expect(sentBytes).toEqual(ORIGINAL_IMAGE);
    expect(brief.image_sha256).toBe(sha256(sentBytes!));
    expect(await readFile(imagePath)).toEqual(Buffer.from('replacement after snapshot'));
    expect((await readdir(path.dirname(artifactPath()))).sort()).toEqual(['page-0001.json']);
  });

  it('rejects an opened source descriptor when pathname replacement changes its ctime', async () => {
    const replacement = Buffer.from('replacement after source open');
    const onContainedOperationReady = vi.fn(async (operation: string) => {
      if (operation !== 'source-read') return;
      await rename(imagePath, `${imagePath}.opened`);
      await writeFile(imagePath, replacement);
    });
    const instance = service({
      testHooks: { onContainedOperationReady },
    } as unknown as Partial<SlideUnderstandingServiceOptions>);

    await expect(instance.ensureBrief(input, model())).rejects.toEqual(
      new SlideUnderstandingError(),
    );

    expect(generateWithImage).not.toHaveBeenCalled();
    expect(await readFile(imagePath)).toEqual(replacement);
    expect(onContainedOperationReady).toHaveBeenCalledWith('source-read');
  });

  it('rejects an in-place same-length source rewrite even when mtime is restored', async () => {
    const fixedTime = new Date('2020-01-02T03:04:05.000Z');
    await utimes(imagePath, fixedTime, fixedTime);
    const before = await stat(imagePath, { bigint: true });
    const replacement = Buffer.alloc(ORIGINAL_IMAGE.byteLength, 0x78);
    const onContainedOperationReady = vi.fn(async (operation: string) => {
      if (operation !== 'source-read') return;
      await writeFile(imagePath, replacement);
      await utimes(imagePath, fixedTime, fixedTime);
      const after = await stat(imagePath, { bigint: true });
      expect(after.dev).toBe(before.dev);
      expect(after.ino).toBe(before.ino);
      expect(after.size).toBe(before.size);
      expect(after.mtimeNs).toBe(before.mtimeNs);
      expect(after.ctimeNs).not.toBe(before.ctimeNs);
    });

    await expect(
      service({
        testHooks: { onContainedOperationReady },
      } as unknown as Partial<SlideUnderstandingServiceOptions>).ensureBrief(input, model()),
    ).rejects.toEqual(new SlideUnderstandingError());

    expect(generateWithImage).not.toHaveBeenCalled();
  });

  it('keeps the source read anchored across a pages-parent swap and restore', async () => {
    const pagesPath = path.dirname(imagePath);
    const movedPagesPath = `${pagesPath}.opened`;
    const replacementPagesPath = `${pagesPath}.replacement`;
    const onContainedOperationReady = vi.fn(async (operation: string) => {
      if (operation !== 'source-read') return;
      await rename(pagesPath, movedPagesPath);
      await mkdir(pagesPath);
      await writeFile(
        path.join(pagesPath, path.basename(imagePath)),
        Buffer.from('replacement parent image'),
      );
      await rename(pagesPath, replacementPagesPath);
      await rename(movedPagesPath, pagesPath);
    });
    try {
      const instance = service({
        testHooks: { onContainedOperationReady },
      } as unknown as Partial<SlideUnderstandingServiceOptions>);

      const brief = await instance.ensureBrief(input, model());

      expect(brief.image_sha256).toBe(sha256(ORIGINAL_IMAGE));
      expect(generateWithImage.mock.calls[0]![0].imageBytes).toEqual(ORIGINAL_IMAGE);
      expect(onContainedOperationReady).toHaveBeenCalledWith('source-read');
    } finally {
      await rm(replacementPagesPath, { recursive: true, force: true });
    }
  });

  it('regenerates when an opened cache pathname replacement changes descriptor ctime', async () => {
    const first = await service().ensureBrief(input, model());
    const originalCache = await readFile(artifactPath(), 'utf8');
    generateWithImage.mockClear();
    const replacement = `${JSON.stringify({ ...first, detected_title: 'Replacement cache' })}\n`;
    const onContainedOperationReady = vi.fn(async (operation: string) => {
      if (operation !== 'cache-read') return;
      await rename(artifactPath(), `${artifactPath()}.opened`);
      await writeFile(artifactPath(), replacement);
    });
    const instance = service({
      testHooks: { onContainedOperationReady },
    } as unknown as Partial<SlideUnderstandingServiceOptions>);

    await expect(instance.ensureBrief(input, model())).resolves.toEqual(first);

    expect(generateWithImage).toHaveBeenCalledOnce();
    expect(await readFile(artifactPath(), 'utf8')).not.toBe(replacement);
    expect(await readFile(`${artifactPath()}.opened`, 'utf8')).toBe(originalCache);
    expect(onContainedOperationReady).toHaveBeenCalledWith('cache-read');
  });

  it('writes cache temp and target through the anchored analysis directory after its path is swapped', async () => {
    const analysisPath = path.dirname(artifactPath());
    const movedAnalysisPath = `${analysisPath}.opened`;
    const marker = path.join(analysisPath, 'replacement-marker.txt');
    const onContainedOperationReady = vi.fn(async (operation: string) => {
      if (operation !== 'cache-write') return;
      await rename(analysisPath, movedAnalysisPath);
      await mkdir(analysisPath, { mode: 0o700 });
      await writeFile(marker, 'must survive');
    });
    const instance = service({
      testHooks: { onContainedOperationReady },
    } as unknown as Partial<SlideUnderstandingServiceOptions>);

    await expect(instance.ensureBrief(input, model())).rejects.toEqual(
      new SlideUnderstandingError(),
    );

    await expect(
      access(path.join(analysisPath, path.basename(artifactPath()))),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(readFile(marker, 'utf8')).resolves.toBe('must survive');
    await expect(
      readFile(path.join(movedAnalysisPath, path.basename(artifactPath())), 'utf8'),
    ).resolves.toContain('"schema_version"');
  });

  it('persists through the original analysis directory across a parent swap and restore', async () => {
    const analysisPath = path.dirname(artifactPath());
    const movedAnalysisPath = `${analysisPath}.opened`;
    const replacementAnalysisPath = `${analysisPath}.replacement`;
    const replacementMarker = path.join(replacementAnalysisPath, 'replacement-marker.txt');
    const onContainedOperationReady = vi.fn(async (operation: string) => {
      if (operation !== 'cache-write') return;
      await rename(analysisPath, movedAnalysisPath);
      await mkdir(analysisPath, { mode: 0o700 });
      await writeFile(path.join(analysisPath, 'replacement-marker.txt'), 'must survive');
      await rename(analysisPath, replacementAnalysisPath);
      await rename(movedAnalysisPath, analysisPath);
    });
    try {
      await expect(
        service({
          testHooks: { onContainedOperationReady },
        } as unknown as Partial<SlideUnderstandingServiceOptions>).ensureBrief(input, model()),
      ).resolves.toMatchObject({
        page_number: 1,
      });

      await expect(readFile(artifactPath(), 'utf8')).resolves.toContain('"schema_version"');
      await expect(readFile(replacementMarker, 'utf8')).resolves.toBe('must survive');
    } finally {
      await rm(replacementAnalysisPath, { recursive: true, force: true });
    }
  });

  it('removes only its owned cache temp when the final target is a replacement directory', async () => {
    await mkdir(path.dirname(artifactPath()), { recursive: true });
    await mkdir(artifactPath());
    const marker = path.join(artifactPath(), 'replacement-marker.txt');
    await writeFile(marker, 'must survive');

    await expect(service().ensureBrief(input, model())).rejects.toEqual(
      new SlideUnderstandingError(),
    );

    await expect(readFile(marker, 'utf8')).resolves.toBe('must survive');
    expect(
      (await readdir(path.dirname(artifactPath()))).filter((entry) => entry.endsWith('.tmp')),
    ).toEqual([]);
  });

  it('never replaces a valid cache artifact when the changed source exceeds the read cap', async () => {
    const instance = service();
    await instance.ensureBrief(input, model());
    const originalArtifact = await readFile(artifactPath(), 'utf8');
    await truncate(imagePath, MAX_INLINE_IMAGE_BYTES + 1);

    await expect(instance.ensureBrief(input, model())).rejects.toEqual(
      new SlideUnderstandingError(),
    );

    expect(await readFile(artifactPath(), 'utf8')).toBe(originalArtifact);
  });

  it('rejects a non-Gemini or internally inconsistent model before file, prompt, or network work', async () => {
    const readPrompt = vi.fn(async () => 'prompt');
    const instance = service({ readPrompt });
    const incompatible = [
      { ...model(), summary: { ...model().summary, provider: 'openai' } },
      {
        ...model(),
        summary: { ...model().summary, capabilities: { text: true, image: false, video: true } },
      },
      { ...model(), summary: { ...model().summary, model: 'gemini-other' } },
      { ...model(), summary: { ...model().summary, role: 'writing' } },
      { ...model(), apiKey: '' },
    ] as unknown as ResolvedVisualModel[];

    for (const routed of incompatible) {
      await expect(
        instance.ensureBrief({ ...input, imagePath: '/missing/private.png' }, routed),
      ).rejects.toEqual(new SlideUnderstandingError());
    }
    expect(readPrompt).not.toHaveBeenCalled();
    expect(generateWithImage).not.toHaveBeenCalled();
  });

  it('bounds private diagnostics to safe identifiers for provider and model-output failures', async () => {
    const privateValues = [
      projectPath,
      imagePath,
      EXTRACTED_TEXT,
      validModelOutput,
      model().apiKey,
      ORIGINAL_IMAGE.toString('base64'),
      'private provider response body',
    ];
    generateWithImage.mockRejectedValueOnce(new Error('private provider response body'));

    await expect(service().ensureBrief(input, model())).rejects.toEqual(
      new SlideUnderstandingError(),
    );

    expect(warn).toHaveBeenCalledWith(
      { errorName: 'Error', presentationId: PRESENTATION_ID, pageNumber: 1 },
      'Slide understanding failed',
    );
    const diagnostics = JSON.stringify(warn.mock.calls);
    for (const privateValue of privateValues) expect(diagnostics).not.toContain(privateValue);
  });

  it('rejects a symlinked project root instead of deriving artifacts through its lexical path', async () => {
    const projectLink = `${projectPath}-link`;
    await symlink(projectPath, projectLink, 'dir');
    try {
      const linkedInput = {
        ...input,
        projectPath: projectLink,
        imagePath: imagePath.replace(projectPath, projectLink),
      };

      await expect(service().ensureBrief(linkedInput, model())).rejects.toEqual(
        new SlideUnderstandingError(),
      );

      expect(generateWithImage).not.toHaveBeenCalled();
    } finally {
      await unlink(projectLink);
    }
  });

  it('creates no cleanup-sensitive snapshot path when transport rejects captured bytes', async () => {
    generateWithImage.mockRejectedValueOnce(new Error('private provider failure'));

    await expect(service().ensureBrief(input, model())).rejects.toEqual(
      new SlideUnderstandingError(),
    );

    expect(
      (await readdir(path.dirname(artifactPath()))).filter((entry) =>
        entry.startsWith('.slide-understanding-'),
      ),
    ).toEqual([]);
  });

  it('immediately releases losing captured buffers for many duplicate same-key callers', async () => {
    const gate = deferred<string>();
    generateWithImage.mockImplementation(() => gate.promise);
    const instance = service();
    const calls = Array.from({ length: 20 }, () => instance.ensureBrief(input, model()));
    await vi.waitFor(() => expect(generateWithImage).toHaveBeenCalledOnce());
    const analysisEntries = await readdir(path.dirname(artifactPath()));

    expect(analysisEntries.filter((entry) => entry.startsWith('.slide-understanding-'))).toEqual(
      [],
    );
    expect(inspectSlideUnderstandingResources(instance)).toEqual({ inFlight: 1, targets: 1 });

    gate.resolve(validModelOutput);
    await Promise.all(calls);
    expect((await readdir(path.dirname(artifactPath()))).sort()).toEqual(['page-0001.json']);
    expect(inspectSlideUnderstandingResources(instance)).toEqual({ inFlight: 0, targets: 0 });
  });

  it('uses an explicit byte cap for cache reads and rejects an oversized prompt before transport', async () => {
    const first = await service().ensureBrief(input, model());
    const cacheText = `${JSON.stringify(first)}\n`;
    generateWithImage.mockClear();
    const readTextFile = vi.fn(async () => cacheText);

    await service({ readTextFile }).ensureBrief(input, model());

    expect(readTextFile).toHaveBeenCalledWith(artifactPath(), 256 * 1024);
    expect(generateWithImage).not.toHaveBeenCalled();

    await rm(artifactPath());
    const oversizedPrompt = service({ readPrompt: async () => 'x'.repeat(20_001) });
    await expect(oversizedPrompt.ensureBrief(input, model())).rejects.toEqual(
      new SlideUnderstandingError(),
    );
    expect(generateWithImage).not.toHaveBeenCalled();
  });

  it('regenerates an oversized real cache through the capped cache reader', async () => {
    await mkdir(path.dirname(artifactPath()), { recursive: true });
    await writeFile(artifactPath(), Buffer.from('{'));
    await truncate(artifactPath(), 256 * 1024 + 1);

    await expect(service().ensureBrief(input, model())).resolves.toMatchObject({ page_number: 1 });

    expect(generateWithImage).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      { errorName: 'UnreadableSlideBriefCache', presentationId: PRESENTATION_ID, pageNumber: 1 },
      'Regenerating unreadable slide brief cache',
    );
  });

  it('rejects an over-cap cache value returned by an injected reader before parsing it', async () => {
    const readTextFile = vi.fn(async () => 'x'.repeat(256 * 1024 + 1));

    await expect(service({ readTextFile }).ensureBrief(input, model())).resolves.toMatchObject({
      page_number: 1,
    });

    expect(generateWithImage).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      { errorName: 'UnreadableSlideBriefCache', presentationId: PRESENTATION_ID, pageNumber: 1 },
      'Regenerating unreadable slide brief cache',
    );
  });

  it('rejects an oversized real source before transport through the capped descriptor reader', async () => {
    await truncate(imagePath, MAX_INLINE_IMAGE_BYTES + 1);

    await expect(service().ensureBrief(input, model())).rejects.toEqual(
      new SlideUnderstandingError(),
    );

    expect(generateWithImage).not.toHaveBeenCalled();
  });

  it('rejects delimiter-collision and other unsafe routed identities before file or transport work', async () => {
    const unsafe = [
      model('alpha\0beta', 'gamma'),
      model('alpha', 'beta\0gamma'),
      model('alpha\u001fbeta'),
      model('alpha\u007fbeta'),
      model('alpha\u0080beta'),
      model('alpha\u009fbeta'),
      model('x'.repeat(201)),
      { ...model(), apiKey: 'private\nkey' },
      { ...model(), apiKey: 'x'.repeat(1_025) },
      model('valid-entry', 'gemini/unsafe'),
      model('valid-entry', 'x'.repeat(201)),
    ] as ResolvedVisualModel[];

    const instance = service();
    const results = await Promise.allSettled(
      unsafe.map((routed) => instance.ensureBrief(input, routed)),
    );

    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect(generateWithImage).not.toHaveBeenCalled();
  });

  it('accepts printable persisted entry IDs containing spaces without weakening concrete model validation', async () => {
    const routed = model('Gemini Pro');

    await expect(service().ensureBrief(input, routed)).resolves.toMatchObject({
      model: { entry_id: 'Gemini Pro', model: 'gemini-2.5-pro' },
    });

    expect(generateWithImage).toHaveBeenCalledOnce();
  });

  it('releases per-target ordering state after many unique targets settle', async () => {
    const instance = service();
    const calls = await Promise.all(
      Array.from({ length: 24 }, async (_unused, index) => {
        const pageNumber = index + 1;
        const pageImagePath = path.join(
          path.dirname(imagePath),
          `page-${String(pageNumber).padStart(4, '0')}.png`,
        );
        await writeFile(pageImagePath, Buffer.from(`page ${pageNumber}`));
        return instance.ensureBrief(
          { ...input, pageNumber, imagePath: pageImagePath },
          model(`entry-${pageNumber}`),
        );
      }),
    );

    expect(calls).toHaveLength(24);
    expect(inspectSlideUnderstandingResources(instance)).toEqual({ inFlight: 0, targets: 0 });
  });

  it('keeps the newest completed freshness generation in the page cache', async () => {
    const older = deferred<string>();
    const newer = deferred<string>();
    const oldOutput = JSON.stringify({
      ...JSON.parse(validModelOutput),
      detected_title: 'Older model',
    });
    const newOutput = JSON.stringify({
      ...JSON.parse(validModelOutput),
      detected_title: 'Newer model',
    });
    generateWithImage.mockImplementation((request: GenerateWithImageInput) =>
      request.model === 'gemini-old' ? older.promise : newer.promise,
    );
    const instance = service();

    const olderCall = instance.ensureBrief(input, model('old-entry', 'gemini-old'));
    await vi.waitFor(() => expect(generateWithImage).toHaveBeenCalledOnce());
    const newerCall = instance.ensureBrief(input, model('new-entry', 'gemini-new'));
    await vi.waitFor(() => expect(generateWithImage).toHaveBeenCalledTimes(2));
    newer.resolve(newOutput);
    await expect(newerCall).resolves.toMatchObject({ detected_title: 'Newer model' });
    older.resolve(oldOutput);
    await expect(olderCall).resolves.toMatchObject({ detected_title: 'Older model' });
    generateWithImage.mockClear();

    await expect(
      instance.ensureBrief(input, model('new-entry', 'gemini-new')),
    ).resolves.toMatchObject({
      detected_title: 'Newer model',
    });
    expect(generateWithImage).not.toHaveBeenCalled();
  });

  it('lets an older successful generation persist when the overlapping newer generation rejects', async () => {
    const older = deferred<string>();
    const newer = deferred<string>();
    generateWithImage.mockImplementation((request: GenerateWithImageInput) =>
      request.model === 'gemini-old' ? older.promise : newer.promise,
    );
    const instance = service();

    const olderCall = instance.ensureBrief(input, model('old-entry', 'gemini-old'));
    await vi.waitFor(() => expect(generateWithImage).toHaveBeenCalledOnce());
    const newerCall = instance.ensureBrief(input, model('new-entry', 'gemini-new'));
    await vi.waitFor(() => expect(generateWithImage).toHaveBeenCalledTimes(2));
    newer.reject(new Error('private newer provider rejection'));
    await expect(newerCall).rejects.toEqual(new SlideUnderstandingError());
    older.resolve(
      JSON.stringify({ ...JSON.parse(validModelOutput), detected_title: 'Older survivor' }),
    );
    await expect(olderCall).resolves.toMatchObject({ detected_title: 'Older survivor' });

    expect(inspectSlideUnderstandingResources(instance)).toEqual({ inFlight: 0, targets: 0 });
    generateWithImage.mockClear();
    await expect(
      instance.ensureBrief(input, model('old-entry', 'gemini-old')),
    ).resolves.toMatchObject({
      detected_title: 'Older survivor',
    });
    expect(generateWithImage).not.toHaveBeenCalled();
  });
});
