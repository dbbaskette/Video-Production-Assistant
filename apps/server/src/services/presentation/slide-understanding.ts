import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  PRESENTATION_SLIDE_BRIEF_PROMPT_VERSION,
  PRESENTATION_SLIDE_BRIEF_SCHEMA_VERSION,
  PresentationSlideBriefSchema,
  type PresentationSlideBrief,
} from '@vpa/shared';
import { z } from 'zod';
import type { ResolvedVisualModel } from '../llm/model-router.js';
import {
  atomicWriteContainedFile,
  ensureContainedDirectory,
  readContainedFile,
  type ContainedOperation,
  type ContainedOperationEvent,
  type ContainedRuntimeOptions,
} from './contained-filesystem.js';
import {
  GeminiImageTransport,
  MAX_INLINE_IMAGE_BYTES,
  isValidGeminiTransportIdentity,
  readBoundedFileNoFollow,
  type GeminiImageTransportLike,
} from './gemini-image.js';

const MAX_EXTRACTED_TEXT_CHARS = 20_000;
const MAX_PROJECT_PATH_CHARS = 4_096;
const MAX_PROMPT_BYTES = 20_000;
const MAX_CACHE_BYTES = 256 * 1024;
const MAX_ARTIFACT_BYTES = 256 * 1024;
const SLIDE_MAX_TOKENS = 4_096;

const InputSchema = z
  .object({
    projectPath: z.string().min(1).max(MAX_PROJECT_PATH_CHARS),
    presentationId: z.string().uuid(),
    pageNumber: z.number().int().positive().max(200),
    imagePath: z.string().min(1).max(MAX_PROJECT_PATH_CHARS),
    extractedText: z.string().max(MAX_EXTRACTED_TEXT_CHARS),
  })
  .strict();

const NonWhitespaceItemSchema = z
  .string()
  .min(1)
  .max(1_000)
  .refine((value) => value.trim().length > 0, 'Item must contain non-whitespace content');
const BriefListSchema = z.array(NonWhitespaceItemSchema).max(50);
const ModelProducedBriefSchema = z
  .object({
    visual_summary: z
      .string()
      .min(1)
      .max(4_000)
      .refine(
        (value) => value.trim().length > 0,
        'visual_summary must contain non-whitespace content',
      ),
    detected_title: z
      .string()
      .max(200)
      .refine(
        (value) => value.length === 0 || value.trim().length > 0,
        'detected_title must be empty or contain non-whitespace content',
      ),
    key_points: BriefListSchema,
    visual_elements: BriefListSchema,
    quantitative_claims: BriefListSchema,
    uncertain_content: BriefListSchema,
  })
  .strict();

export interface EnsureSlideBriefInput {
  projectPath: string;
  presentationId: string;
  pageNumber: number;
  imagePath: string;
  extractedText: string;
}

export type SlideUnderstandingWarning = (fields: Record<string, unknown>, message: string) => void;

export interface SlideUnderstandingServiceOptions {
  workspaceRoot: string;
  transport?: GeminiImageTransportLike;
  readPrompt?: () => Promise<string>;
  readTextFile?: (path: string, maxBytes: number) => Promise<string>;
  testHooks?: {
    onContainedOperationReady?: (operation: ContainedOperation) => Promise<void> | void;
    onContainedOperationEvent?: (event: ContainedOperationEvent) => Promise<void> | void;
    helperTimeoutMs?: number;
    helperTerminationGraceMs?: number;
    helperChildBehavior?: ContainedRuntimeOptions['childBehavior'];
  };
  warn: SlideUnderstandingWarning;
}

export class SlideUnderstandingError extends Error {
  readonly code = 'slide_understanding_failed';

  constructor() {
    super('Slide understanding failed.');
    this.name = 'SlideUnderstandingError';
  }
}

interface FileIdentity {
  dev: bigint;
  ino: bigint;
}

interface DirectoryIdentity extends FileIdentity {
  path: string;
}

interface BundlePaths {
  project: DirectoryIdentity;
  bundle: DirectoryIdentity;
  pages: DirectoryIdentity;
  analysis: DirectoryIdentity;
  imagePath: string;
  artifactPath: string;
}

interface TargetState {
  nextGeneration: number;
  latestCompletedGeneration: number;
  activeGenerations: number;
  writeTail?: Promise<void>;
}

function pageName(pageNumber: number, extension: 'png' | 'json'): string {
  return `page-${String(pageNumber).padStart(4, '0')}.${extension}`;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined;
}

function safeErrorName(error: unknown): string {
  if (!(error instanceof Error)) return 'UnknownError';
  return new Set([
    'Error',
    'GeminiImageTransportError',
    'SlideUnderstandingError',
    'SyntaxError',
    'ZodError',
  ]).has(error.name)
    ? error.name
    : 'Error';
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function currentIdentity(target: string): Promise<
  FileIdentity & {
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  }
> {
  const current = await lstat(target, { bigint: true });
  return current;
}

async function assertNoSymlinkAncestors(target: string): Promise<void> {
  const resolved = path.resolve(target);
  const root = path.parse(resolved).root;
  const relative = resolved.slice(root.length);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw new SlideUnderstandingError();
  }
}

async function canonicalDirectory(target: string): Promise<DirectoryIdentity> {
  if (!path.isAbsolute(target) || path.resolve(target) !== target)
    throw new SlideUnderstandingError();
  await assertNoSymlinkAncestors(target);
  if ((await realpath(target)) !== target) throw new SlideUnderstandingError();
  const stat = await currentIdentity(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new SlideUnderstandingError();
  return { path: target, dev: stat.dev, ino: stat.ino };
}

async function assertDirectoryIdentity(expected: DirectoryIdentity): Promise<void> {
  const stat = await currentIdentity(expected.path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    !sameIdentity(stat, expected) ||
    (await realpath(expected.path)) !== expected.path
  ) {
    throw new SlideUnderstandingError();
  }
}

async function resolveBundlePaths(
  input: EnsureSlideBriefInput,
  runtime: ContainedRuntimeOptions,
): Promise<BundlePaths> {
  const projectPath = path.resolve(input.projectPath);
  if (projectPath !== input.projectPath) throw new SlideUnderstandingError();
  const project = await canonicalDirectory(projectPath);
  const bundlePath = path.join(project.path, 'presentations', input.presentationId);
  const bundle = await canonicalDirectory(bundlePath);
  const pages = await canonicalDirectory(path.join(bundle.path, 'pages'));
  const imagePath = path.join(pages.path, pageName(input.pageNumber, 'png'));
  if (input.imagePath !== imagePath) throw new SlideUnderstandingError();

  const analysisPath = path.join(bundle.path, 'analysis');
  let analysis: DirectoryIdentity;
  try {
    const existing = await canonicalDirectory(analysisPath);
    const stat = await lstat(analysisPath, { bigint: true });
    analysis =
      (stat.mode & 0o777n) === 0o700n
        ? existing
        : await ensureContainedDirectory(bundle, 'analysis', runtime);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
    analysis = await ensureContainedDirectory(bundle, 'analysis', runtime);
  }
  await assertDirectoryIdentity(project);
  await assertDirectoryIdentity(bundle);
  await assertDirectoryIdentity(pages);
  return {
    project,
    bundle,
    pages,
    analysis,
    imagePath,
    artifactPath: path.join(analysis.path, pageName(input.pageNumber, 'json')),
  };
}

async function readBoundedTextNoFollow(target: string, maxBytes: number): Promise<string> {
  return (await readBoundedFileNoFollow(target, maxBytes)).toString('utf8');
}

function validateVisualModel(model: ResolvedVisualModel): void {
  const summary = model?.summary;
  if (
    !model ||
    !summary ||
    summary.role !== 'video-understanding' ||
    summary.provider !== 'gemini' ||
    summary.ready !== true ||
    summary.capabilities?.image !== true ||
    summary.model !== model.model ||
    !isValidGeminiTransportIdentity({
      apiKey: model.apiKey,
      model: model.model,
      entryId: summary.entry_id,
    })
  ) {
    throw new SlideUnderstandingError();
  }
}

function parseSingleJsonObject(output: string): unknown {
  const trimmed = output.trim();
  const openingFence = /^```(?:json)?[ \t]*\r?\n/i.exec(trimmed);
  let jsonText = trimmed;
  if (openingFence) {
    const closingFence = /\r?\n```$/.exec(trimmed);
    if (!closingFence) throw new SlideUnderstandingError();
    jsonText = trimmed.slice(openingFence[0].length, closingFence.index).trim();
    if (jsonText.includes('```')) throw new SlideUnderstandingError();
  } else if (trimmed.includes('```')) {
    throw new SlideUnderstandingError();
  }
  const parsed = JSON.parse(jsonText) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SlideUnderstandingError();
  }
  return parsed;
}

function modelFieldsFromBrief(brief: PresentationSlideBrief): unknown {
  return {
    visual_summary: brief.visual_summary,
    detected_title: brief.detected_title,
    key_points: brief.key_points,
    visual_elements: brief.visual_elements,
    quantitative_claims: brief.quantitative_claims,
    uncertain_content: brief.uncertain_content,
  };
}

function isFresh(
  brief: PresentationSlideBrief,
  input: EnsureSlideBriefInput,
  imageSha256: string,
  extractedTextSha256: string,
  model: ResolvedVisualModel,
): boolean {
  return (
    brief.schema_version === PRESENTATION_SLIDE_BRIEF_SCHEMA_VERSION &&
    brief.prompt_version === PRESENTATION_SLIDE_BRIEF_PROMPT_VERSION &&
    brief.presentation_id === input.presentationId &&
    brief.page_number === input.pageNumber &&
    brief.image_sha256 === imageSha256 &&
    brief.extracted_text_sha256 === extractedTextSha256 &&
    brief.model.provider === 'gemini' &&
    brief.model.entry_id === model.summary.entry_id &&
    brief.model.model === model.model
  );
}

function requestKey(fields: {
  projectPath: string;
  presentationId: string;
  pageNumber: number;
  imagePath: string;
  extractedTextSha256: string;
  entryId: string;
  model: string;
}): string {
  return JSON.stringify({
    projectPath: fields.projectPath,
    presentationId: fields.presentationId,
    pageNumber: fields.pageNumber,
    imagePath: fields.imagePath,
    extractedTextSha256: fields.extractedTextSha256,
    entryId: fields.entryId,
    model: fields.model,
    schemaVersion: PRESENTATION_SLIDE_BRIEF_SCHEMA_VERSION,
    promptVersion: PRESENTATION_SLIDE_BRIEF_PROMPT_VERSION,
  });
}

export class SlideUnderstandingService {
  private readonly transport: GeminiImageTransportLike;
  private readonly readPrompt: () => Promise<string>;
  private readonly readTextFile?: (path: string, maxBytes: number) => Promise<string>;
  private readonly containedRuntime: ContainedRuntimeOptions;
  private readonly warn: SlideUnderstandingWarning;
  private readonly inFlight = new Map<string, Promise<PresentationSlideBrief>>();
  private readonly targetStates = new Map<string, TargetState>();
  private promptCache?: Promise<string>;

  constructor(options: SlideUnderstandingServiceOptions) {
    this.transport = options.transport ?? new GeminiImageTransport();
    this.readPrompt =
      options.readPrompt ??
      (() =>
        readBoundedTextNoFollow(
          path.join(
            options.workspaceRoot,
            'apps',
            'server',
            'prompts',
            'presentation-slide-understanding.md',
          ),
          MAX_PROMPT_BYTES,
        ));
    this.readTextFile = options.readTextFile;
    this.containedRuntime = {
      timeoutMs: options.testHooks?.helperTimeoutMs,
      terminationGraceMs: options.testHooks?.helperTerminationGraceMs,
      childBehavior: options.testHooks?.helperChildBehavior,
      onEvent:
        options.testHooks?.onContainedOperationReady || options.testHooks?.onContainedOperationEvent
          ? async (event) => {
              if (event.stage === 'ready') {
                await options.testHooks?.onContainedOperationReady?.(event.operation);
              }
              await options.testHooks?.onContainedOperationEvent?.(event);
            }
          : undefined,
    };
    this.warn = options.warn;
  }

  private warnSafely(
    input: Pick<EnsureSlideBriefInput, 'presentationId' | 'pageNumber'>,
    errorName: string,
    message: string,
  ): void {
    try {
      this.warn(
        { errorName, presentationId: input.presentationId, pageNumber: input.pageNumber },
        message,
      );
    } catch {
      // Diagnostics must never change generation or cleanup behavior.
    }
  }

  private async readCache(
    paths: BundlePaths,
    input: EnsureSlideBriefInput,
  ): Promise<PresentationSlideBrief | undefined> {
    await assertDirectoryIdentity(paths.analysis);
    let raw: string;
    try {
      raw = this.readTextFile
        ? await this.readTextFile(paths.artifactPath, MAX_CACHE_BYTES)
        : (
            await readContainedFile(
              paths.analysis,
              path.basename(paths.artifactPath),
              MAX_CACHE_BYTES,
              'cache-read',
              this.containedRuntime,
            )
          ).toString('utf8');
    } catch (error) {
      await assertDirectoryIdentity(paths.analysis);
      if (errorCode(error) === 'ENOENT') return undefined;
      this.warnSafely(
        input,
        'UnreadableSlideBriefCache',
        'Regenerating unreadable slide brief cache',
      );
      return undefined;
    }
    await assertDirectoryIdentity(paths.analysis);
    if (Buffer.byteLength(raw, 'utf8') > MAX_CACHE_BYTES) {
      this.warnSafely(
        input,
        'UnreadableSlideBriefCache',
        'Regenerating unreadable slide brief cache',
      );
      return undefined;
    }
    try {
      const brief = PresentationSlideBriefSchema.parse(JSON.parse(raw));
      ModelProducedBriefSchema.parse(modelFieldsFromBrief(brief));
      return brief;
    } catch {
      this.warnSafely(input, 'InvalidSlideBriefCache', 'Regenerating invalid slide brief cache');
      return undefined;
    }
  }

  private acquireTargetGeneration(target: string): { generation: number; state: TargetState } {
    const state = this.targetStates.get(target) ?? {
      nextGeneration: 0,
      latestCompletedGeneration: 0,
      activeGenerations: 0,
    };
    if (!this.targetStates.has(target)) this.targetStates.set(target, state);
    state.nextGeneration += 1;
    state.activeGenerations += 1;
    return { generation: state.nextGeneration, state };
  }

  private releaseTargetGeneration(target: string, state: TargetState): void {
    state.activeGenerations -= 1;
    this.deleteIdleTargetState(target, state);
  }

  private deleteIdleTargetState(target: string, state: TargetState): void {
    if (
      state.activeGenerations === 0 &&
      state.writeTail === undefined &&
      this.targetStates.get(target) === state
    ) {
      this.targetStates.delete(target);
    }
  }

  private markCompleted(state: TargetState, generation: number): void {
    state.latestCompletedGeneration = Math.max(state.latestCompletedGeneration, generation);
  }

  private async persistIfLatest(
    paths: BundlePaths,
    state: TargetState,
    generation: number,
    data: string,
  ): Promise<void> {
    const target = paths.artifactPath;
    const previous = state.writeTail ?? Promise.resolve();
    const write = previous
      .catch(() => undefined)
      .then(async () => {
        if (state.latestCompletedGeneration !== generation) return;
        await assertDirectoryIdentity(paths.analysis);
        const bytes = Buffer.from(data, 'utf8');
        if (bytes.byteLength > MAX_ARTIFACT_BYTES) throw new SlideUnderstandingError();
        await atomicWriteContainedFile(
          paths.analysis,
          path.basename(target),
          bytes,
          MAX_ARTIFACT_BYTES,
          this.containedRuntime,
        );
        await assertDirectoryIdentity(paths.analysis);
      });
    const tracked = write.finally(() => {
      if (state.writeTail === tracked) state.writeTail = undefined;
      this.deleteIdleTargetState(target, state);
    });
    state.writeTail = tracked;
    await tracked;
  }

  async ensureBrief(
    uncheckedInput: EnsureSlideBriefInput,
    model: ResolvedVisualModel,
  ): Promise<PresentationSlideBrief> {
    validateVisualModel(model);
    const parsedInput = InputSchema.safeParse(uncheckedInput);
    if (!parsedInput.success) throw new SlideUnderstandingError();
    const input = parsedInput.data;

    const key = requestKey({
      projectPath: input.projectPath,
      presentationId: input.presentationId,
      pageNumber: input.pageNumber,
      imagePath: input.imagePath,
      extractedTextSha256: sha256(input.extractedText),
      entryId: model.summary.entry_id,
      model: model.model,
    });
    const current = this.inFlight.get(key);
    if (current) return await current;
    const generated = this.ensureBriefOnce(input, model);
    const tracked = generated.finally(() => {
      if (this.inFlight.get(key) === tracked) this.inFlight.delete(key);
    });
    this.inFlight.set(key, tracked);
    return await tracked;
  }

  private async ensureBriefOnce(
    input: EnsureSlideBriefInput,
    model: ResolvedVisualModel,
  ): Promise<PresentationSlideBrief> {
    let imageBytes: Buffer | undefined;
    try {
      const paths = await resolveBundlePaths(input, this.containedRuntime);
      imageBytes = await readContainedFile(
        paths.pages,
        path.basename(paths.imagePath),
        MAX_INLINE_IMAGE_BYTES,
        'source-read',
        this.containedRuntime,
      );
      if (imageBytes.byteLength === 0 || imageBytes.byteLength > MAX_INLINE_IMAGE_BYTES) {
        throw new SlideUnderstandingError();
      }
      const imageSha256 = sha256(imageBytes);
      const extractedTextSha256 = sha256(input.extractedText);
      const cached = await this.readCache(paths, input);
      if (cached && isFresh(cached, input, imageSha256, extractedTextSha256, model)) {
        return cached;
      }

      const { generation, state } = this.acquireTargetGeneration(paths.artifactPath);
      const generatedBrief = this.generateBrief(
        input,
        paths,
        imageBytes,
        imageSha256,
        extractedTextSha256,
        model,
        state,
        generation,
      );
      imageBytes = undefined;
      return await generatedBrief.finally(() => {
        this.releaseTargetGeneration(paths.artifactPath, state);
      });
    } catch (error) {
      if (error instanceof SlideUnderstandingError) throw error;
      this.warnSafely(input, safeErrorName(error), 'Slide understanding failed');
      throw new SlideUnderstandingError();
    } finally {
      imageBytes = undefined;
    }
  }

  private async systemPrompt(): Promise<string> {
    if (this.promptCache) return await this.promptCache;
    const loaded = this.readPrompt().then((systemPrompt) => {
      if (
        Buffer.byteLength(systemPrompt, 'utf8') > MAX_PROMPT_BYTES ||
        systemPrompt.trim().length === 0
      ) {
        throw new SlideUnderstandingError();
      }
      return systemPrompt;
    });
    this.promptCache = loaded;
    try {
      return await loaded;
    } catch (error) {
      if (this.promptCache === loaded) this.promptCache = undefined;
      throw error;
    }
  }

  private async generateBrief(
    input: EnsureSlideBriefInput,
    paths: BundlePaths,
    imageBytes: Buffer,
    imageSha256: string,
    extractedTextSha256: string,
    model: ResolvedVisualModel,
    state: TargetState,
    generation: number,
  ): Promise<PresentationSlideBrief> {
    try {
      const systemPrompt = await this.systemPrompt();
      const output = await this.transport.generateWithImage({
        apiKey: model.apiKey,
        model: model.model,
        systemPrompt,
        userPrompt: [
          `Analyze slide ${input.pageNumber}.`,
          'Use the PNG as the visual source of truth. The exact extracted PDF text follows:',
          input.extractedText,
        ].join('\n'),
        imageBytes,
        imageMimeType: 'image/png',
        responseMimeType: 'application/json',
        maxTokens: SLIDE_MAX_TOKENS,
        expectedImageSha256: imageSha256,
      });
      const modelFields = ModelProducedBriefSchema.parse(parseSingleJsonObject(output));
      const brief = PresentationSlideBriefSchema.parse({
        schema_version: PRESENTATION_SLIDE_BRIEF_SCHEMA_VERSION,
        presentation_id: input.presentationId,
        page_number: input.pageNumber,
        image_sha256: imageSha256,
        extracted_text_sha256: extractedTextSha256,
        model: {
          entry_id: model.summary.entry_id,
          provider: 'gemini',
          model: model.model,
        },
        prompt_version: PRESENTATION_SLIDE_BRIEF_PROMPT_VERSION,
        ...modelFields,
      });
      this.markCompleted(state, generation);
      await this.persistIfLatest(paths, state, generation, `${JSON.stringify(brief, null, 2)}\n`);
      return brief;
    } catch (error) {
      this.warnSafely(input, safeErrorName(error), 'Slide understanding failed');
      throw new SlideUnderstandingError();
    }
  }
}

export function inspectSlideUnderstandingResources(service: SlideUnderstandingService): {
  inFlight: number;
  targets: number;
} {
  const internal = service as unknown as {
    inFlight: Map<string, unknown>;
    targetStates: Map<string, unknown>;
  };
  return { inFlight: internal.inFlight.size, targets: internal.targetStates.size };
}
