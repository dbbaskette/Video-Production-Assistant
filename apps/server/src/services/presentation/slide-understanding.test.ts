import { createHash } from 'node:crypto';
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  PRESENTATION_SLIDE_BRIEF_PROMPT_VERSION,
  PRESENTATION_SLIDE_BRIEF_SCHEMA_VERSION,
  PresentationSlideBriefSchema,
} from '@vpa/shared';
import { afterEach, beforeEach, describe, expect, it, vi, type MockedFunction } from 'vitest';
import type { ResolvedVisualModel } from '../llm/model-router.js';
import type { GenerateWithImageInput, GeminiImageTransportLike } from './gemini-image.js';
import {
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
    projectPath = await mkdtemp(path.join(tmpdir(), 'vpa-slide-understanding-'));
    imagePath = path.join(
      projectPath,
      'presentations',
      PRESENTATION_ID,
      'pages',
      'page-0001.png',
    );
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
    generateWithImage = vi.fn(async (_request: GenerateWithImageInput) => validModelOutput) as MockedFunction<
      GeminiImageTransportLike['generateWithImage']
    >;
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
    expect(Object.keys(persisted).sort()).toEqual([
      'detected_title', 'extracted_text_sha256', 'image_sha256', 'key_points', 'model',
      'page_number', 'presentation_id', 'prompt_version', 'quantitative_claims',
      'schema_version', 'uncertain_content', 'visual_elements', 'visual_summary',
    ].sort());
    expect(generateWithImage).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: 'private-api-key',
      model: 'gemini-2.5-pro',
      systemPrompt: 'Exact versioned visual prompt.',
      imageMimeType: 'image/png',
      responseMimeType: 'application/json',
      maxTokens: 4_096,
    }));
    const request = generateWithImage.mock.calls[0]![0] as GenerateWithImageInput;
    expect(request.userPrompt).toContain('Analyze slide 1.');
    expect(request.userPrompt).toContain(EXTRACTED_TEXT);
    expect(request.imagePath).not.toBe(imagePath);
    expect(request.imagePath.startsWith(path.dirname(artifactPath()))).toBe(true);
    await expect(access(request.imagePath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(path.dirname(artifactPath()))).sort()).toEqual(['page-0001.json']);
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
    ['missing key', JSON.stringify({
      visual_summary: 'A revenue chart rises from Q1 through Q4.',
      key_points: ['Revenue increased throughout the year.'],
      visual_elements: ['A blue line chart with four quarterly labels.'],
      quantitative_claims: ['Revenue increased 18% to $4.2M.'],
      uncertain_content: [],
    })],
    ['wrong type', JSON.stringify({ ...JSON.parse(validModelOutput), key_points: 'not an array' })],
    ['too many list items', JSON.stringify({ ...JSON.parse(validModelOutput), key_points: Array(51).fill('point') })],
    ['an oversized list item', JSON.stringify({ ...JSON.parse(validModelOutput), key_points: ['x'.repeat(1_001)] })],
    ['an empty list item', JSON.stringify({ ...JSON.parse(validModelOutput), key_points: [''] })],
  ])('rejects and does not persist %s', async (_label, output) => {
    generateWithImage.mockResolvedValueOnce(output);

    await expect(service().ensureBrief(input, model())).rejects.toEqual(new SlideUnderstandingError());

    await expect(access(artifactPath())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reuses an exactly fresh cache entry with zero transport and prompt calls', async () => {
    const readPrompt = vi.fn(async () => 'Exact versioned visual prompt.');
    const instance = service({ readPrompt });
    const first = await instance.ensureBrief(input, model());
    generateWithImage.mockClear();
    readPrompt.mockClear();

    const second = await instance.ensureBrief(input, model());

    expect(second).toEqual(first);
    expect(generateWithImage).not.toHaveBeenCalled();
    expect(readPrompt).not.toHaveBeenCalled();
  });

  it('invalidates independently on image bytes, exact extracted text, model entry, and concrete model', async () => {
    const instance = service();
    await instance.ensureBrief(input, model());
    await writeFile(imagePath, Buffer.from('changed image bytes'));
    const changedImage = await instance.ensureBrief(input, model());
    const changedText = await instance.ensureBrief({ ...input, extractedText: `${EXTRACTED_TEXT} ` }, model());
    const changedEntry = await instance.ensureBrief(input, model('visual-entry-next'));
    const changedConcrete = await instance.ensureBrief(input, model('visual-entry-next', 'gemini-3-pro'));

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

    const first = instance.ensureBrief(input, model());
    const second = instance.ensureBrief(input, model());
    await vi.waitFor(() => expect(generateWithImage).toHaveBeenCalledOnce());
    gate.resolve(validModelOutput);

    const [one, two] = await Promise.all([first, second]);
    expect(two).toEqual(one);
  });

  it('does not deduplicate different pages, models, or image hashes', async () => {
    const secondImage = path.join(path.dirname(imagePath), 'page-0002.png');
    await writeFile(secondImage, Buffer.from('page two image'));
    const gates = [deferred<string>(), deferred<string>(), deferred<string>()];
    generateWithImage.mockImplementation(() => gates[generateWithImage.mock.calls.length - 1]!.promise);
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

    await expect(instance.ensureBrief(input, model())).rejects.toEqual(new SlideUnderstandingError());
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

    await expect(service().ensureBrief(input, model())).rejects.toEqual(new SlideUnderstandingError());

    expect(generateWithImage).not.toHaveBeenCalled();
  });

  it('hashes and sends the same contained snapshot bytes when the source changes during generation', async () => {
    let sentBytes: Buffer | undefined;
    let snapshotPath: string | undefined;
    generateWithImage.mockImplementation(async (request: GenerateWithImageInput) => {
      snapshotPath = request.imagePath;
      sentBytes = await readFile(request.imagePath);
      await writeFile(imagePath, Buffer.from('replacement after snapshot'));
      return validModelOutput;
    });

    const brief = await service().ensureBrief(input, model());

    expect(sentBytes).toEqual(ORIGINAL_IMAGE);
    expect(brief.image_sha256).toBe(sha256(sentBytes!));
    expect(await readFile(imagePath)).toEqual(Buffer.from('replacement after snapshot'));
    expect(snapshotPath!.startsWith(path.join(projectPath, 'presentations', PRESENTATION_ID))).toBe(true);
    await expect(access(snapshotPath!)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never replaces a valid cache artifact when snapshot creation cannot proceed', async () => {
    const instance = service();
    await instance.ensureBrief(input, model());
    const originalArtifact = await readFile(artifactPath(), 'utf8');
    await writeFile(imagePath, Buffer.from('stale source'));
    await chmod(path.dirname(artifactPath()), 0o500);
    try {
      await expect(instance.ensureBrief(input, model())).rejects.toEqual(new SlideUnderstandingError());
    } finally {
      await chmod(path.dirname(artifactPath()), 0o700);
    }

    expect(await readFile(artifactPath(), 'utf8')).toBe(originalArtifact);
  });

  it('rejects a non-Gemini or internally inconsistent model before file, prompt, or network work', async () => {
    const readPrompt = vi.fn(async () => 'prompt');
    const instance = service({ readPrompt });
    const incompatible = [
      { ...model(), summary: { ...model().summary, provider: 'openai' } },
      { ...model(), summary: { ...model().summary, capabilities: { text: true, image: false, video: true } } },
      { ...model(), summary: { ...model().summary, model: 'gemini-other' } },
      { ...model(), summary: { ...model().summary, role: 'writing' } },
      { ...model(), apiKey: '' },
    ] as unknown as ResolvedVisualModel[];

    for (const routed of incompatible) {
      await expect(instance.ensureBrief({ ...input, imagePath: '/missing/private.png' }, routed)).rejects.toEqual(
        new SlideUnderstandingError(),
      );
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

    await expect(service().ensureBrief(input, model())).rejects.toEqual(new SlideUnderstandingError());

    expect(warn).toHaveBeenCalledWith(
      { errorName: 'Error', presentationId: PRESENTATION_ID, pageNumber: 1 },
      'Slide understanding failed',
    );
    const diagnostics = JSON.stringify(warn.mock.calls);
    for (const privateValue of privateValues) expect(diagnostics).not.toContain(privateValue);
  });
});
