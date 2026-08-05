import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import {
  PRESENTATION_SLIDE_BRIEF_PROMPT_VERSION,
  PRESENTATION_SLIDE_BRIEF_SCHEMA_VERSION,
  PresentationSlideBriefSchema,
  type PresentationSlideBrief,
} from '@vpa/shared';
import { z } from 'zod';
import { atomicWriteFile } from '../../lib/fs-atomic.js';
import type { ResolvedVisualModel } from '../llm/model-router.js';
import {
  GeminiImageTransport,
  MAX_INLINE_IMAGE_BYTES,
  type GeminiImageTransportLike,
} from './gemini-image.js';

const MAX_EXTRACTED_TEXT_CHARS = 20_000;
const MAX_PROJECT_PATH_CHARS = 4_096;
const MAX_MODEL_CHARS = 500;
const MAX_ENTRY_ID_CHARS = 200;
const SLIDE_MAX_TOKENS = 4_096;

const InputSchema = z.object({
  projectPath: z.string().min(1).max(MAX_PROJECT_PATH_CHARS),
  presentationId: z.string().uuid(),
  pageNumber: z.number().int().positive().max(200),
  imagePath: z.string().min(1).max(MAX_PROJECT_PATH_CHARS),
  extractedText: z.string().max(MAX_EXTRACTED_TEXT_CHARS),
}).strict();

const BriefListSchema = z.array(z.string().min(1).max(1_000)).max(50);
const ModelProducedBriefSchema = z.object({
  visual_summary: z.string().min(1).max(4_000),
  detected_title: z.string().max(200),
  key_points: BriefListSchema,
  visual_elements: BriefListSchema,
  quantitative_claims: BriefListSchema,
  uncertain_content: BriefListSchema,
}).strict();

export interface EnsureSlideBriefInput {
  projectPath: string;
  presentationId: string;
  pageNumber: number;
  imagePath: string;
  extractedText: string;
}

export type SlideUnderstandingWarning = (
  fields: Record<string, unknown>,
  message: string,
) => void;

export interface SlideUnderstandingServiceOptions {
  workspaceRoot: string;
  transport?: GeminiImageTransportLike;
  readPrompt?: () => Promise<string>;
  readTextFile?: (path: string) => Promise<string>;
  persist?: (path: string, data: string) => Promise<void>;
  warn: SlideUnderstandingWarning;
}

export class SlideUnderstandingError extends Error {
  readonly code = 'slide_understanding_failed';

  constructor() {
    super('Slide understanding failed.');
    this.name = 'SlideUnderstandingError';
  }
}

interface ImageSnapshot {
  path: string;
  bundlePath: string;
  bytes: Buffer;
  cleanup(): Promise<void>;
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
  ]).has(error.name) ? error.name : 'Error';
}

function validateVisualModel(model: ResolvedVisualModel): void {
  const summary = model?.summary;
  if (
    !model
    || typeof model.apiKey !== 'string'
    || model.apiKey.length < 1
    || model.apiKey.length > 1_024
    || typeof model.model !== 'string'
    || model.model.length < 1
    || model.model.length > MAX_MODEL_CHARS
    || !summary
    || summary.role !== 'video-understanding'
    || summary.provider !== 'gemini'
    || summary.ready !== true
    || summary.capabilities?.image !== true
    || typeof summary.entry_id !== 'string'
    || summary.entry_id.length < 1
    || summary.entry_id.length > MAX_ENTRY_ID_CHARS
    || summary.model !== model.model
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

async function readTextNoFollow(target: string): Promise<string> {
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  const handle = await open(target, constants.O_RDONLY | noFollow);
  try {
    return await handle.readFile({ encoding: 'utf8' });
  } finally {
    await handle.close();
  }
}

async function createImageSnapshot(input: EnsureSlideBriefInput): Promise<ImageSnapshot> {
  const lexicalProject = path.resolve(input.projectPath);
  const lexicalBundle = path.join(lexicalProject, 'presentations', input.presentationId);
  const lexicalImage = path.join(lexicalBundle, 'pages', pageName(input.pageNumber, 'png'));
  if (!path.isAbsolute(input.projectPath) || path.resolve(input.imagePath) !== lexicalImage) {
    throw new SlideUnderstandingError();
  }

  const canonicalProject = await realpath(lexicalProject);
  const canonicalBundle = path.join(canonicalProject, 'presentations', input.presentationId);
  if (await realpath(lexicalBundle) !== canonicalBundle) throw new SlideUnderstandingError();
  if (await realpath(lexicalImage) !== path.join(canonicalBundle, 'pages', pageName(input.pageNumber, 'png'))) {
    throw new SlideUnderstandingError();
  }

  const sourcePathStat = await lstat(lexicalImage, { bigint: true });
  if (!sourcePathStat.isFile() || sourcePathStat.isSymbolicLink()) throw new SlideUnderstandingError();
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  const source = await open(lexicalImage, constants.O_RDONLY | noFollow);
  let bytes: Buffer;
  try {
    const before = await source.stat({ bigint: true });
    const currentPathStat = await lstat(lexicalImage, { bigint: true });
    if (
      !before.isFile()
      || await realpath(lexicalImage) !== path.join(canonicalBundle, 'pages', pageName(input.pageNumber, 'png'))
      || currentPathStat.isSymbolicLink()
      || before.dev !== sourcePathStat.dev
      || before.ino !== sourcePathStat.ino
      || before.dev !== currentPathStat.dev
      || before.ino !== currentPathStat.ino
    ) {
      throw new SlideUnderstandingError();
    }
    bytes = await source.readFile();
    const after = await source.stat({ bigint: true });
    if (
      after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || after.mtimeNs !== before.mtimeNs
      || after.ctimeNs !== before.ctimeNs
    ) {
      throw new SlideUnderstandingError();
    }
  } finally {
    await source.close();
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_INLINE_IMAGE_BYTES) {
    throw new SlideUnderstandingError();
  }

  const analysisPath = path.join(lexicalBundle, 'analysis');
  await mkdir(analysisPath, { recursive: true });
  const analysisStat = await lstat(analysisPath, { bigint: true });
  const canonicalAnalysis = path.join(canonicalBundle, 'analysis');
  if (
    !analysisStat.isDirectory()
    || analysisStat.isSymbolicLink()
    || await realpath(analysisPath) !== canonicalAnalysis
  ) {
    throw new SlideUnderstandingError();
  }

  const directory = await mkdtemp(path.join(analysisPath, '.slide-understanding-'));
  const snapshotPath = path.join(directory, `${randomUUID()}.png`);
  try {
    const currentAnalysisStat = await lstat(analysisPath, { bigint: true });
    if (
      currentAnalysisStat.isSymbolicLink()
      || currentAnalysisStat.dev !== analysisStat.dev
      || currentAnalysisStat.ino !== analysisStat.ino
      || await realpath(directory) !== path.join(canonicalAnalysis, path.basename(directory))
    ) {
      throw new SlideUnderstandingError();
    }
    await writeFile(snapshotPath, bytes, { flag: 'wx', mode: 0o400 });
    await chmod(snapshotPath, 0o400);
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return {
    path: snapshotPath,
    bundlePath: canonicalBundle,
    bytes,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

function isFresh(
  brief: PresentationSlideBrief,
  input: EnsureSlideBriefInput,
  imageSha256: string,
  extractedTextSha256: string,
  model: ResolvedVisualModel,
): boolean {
  return brief.schema_version === PRESENTATION_SLIDE_BRIEF_SCHEMA_VERSION
    && brief.prompt_version === PRESENTATION_SLIDE_BRIEF_PROMPT_VERSION
    && brief.presentation_id === input.presentationId
    && brief.page_number === input.pageNumber
    && brief.image_sha256 === imageSha256
    && brief.extracted_text_sha256 === extractedTextSha256
    && brief.model.provider === 'gemini'
    && brief.model.entry_id === model.summary.entry_id
    && brief.model.model === model.model;
}

export class SlideUnderstandingService {
  private readonly transport: GeminiImageTransportLike;
  private readonly readPrompt: () => Promise<string>;
  private readonly readTextFile: (path: string) => Promise<string>;
  private readonly persist: (path: string, data: string) => Promise<void>;
  private readonly warn: SlideUnderstandingWarning;
  private readonly inFlight = new Map<string, Promise<PresentationSlideBrief>>();

  constructor(options: SlideUnderstandingServiceOptions) {
    this.transport = options.transport ?? new GeminiImageTransport();
    this.readPrompt = options.readPrompt ?? (() => readTextNoFollow(path.join(
      options.workspaceRoot,
      'apps',
      'server',
      'prompts',
      'presentation-slide-understanding.md',
    )));
    this.readTextFile = options.readTextFile ?? readTextNoFollow;
    this.persist = options.persist ?? atomicWriteFile;
    this.warn = options.warn;
  }

  private warnSafely(
    input: Pick<EnsureSlideBriefInput, 'presentationId' | 'pageNumber'>,
    errorName: string,
    message: string,
  ): void {
    try {
      this.warn({ errorName, presentationId: input.presentationId, pageNumber: input.pageNumber }, message);
    } catch {
      // Diagnostics must never change generation or cleanup behavior.
    }
  }

  private async readCache(
    target: string,
    input: EnsureSlideBriefInput,
  ): Promise<PresentationSlideBrief | undefined> {
    let raw: string;
    try {
      raw = await this.readTextFile(target);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return undefined;
      this.warnSafely(input, 'UnreadableSlideBriefCache', 'Regenerating unreadable slide brief cache');
      return undefined;
    }
    try {
      return PresentationSlideBriefSchema.parse(JSON.parse(raw));
    } catch {
      this.warnSafely(input, 'InvalidSlideBriefCache', 'Regenerating invalid slide brief cache');
      return undefined;
    }
  }

  async ensureBrief(
    uncheckedInput: EnsureSlideBriefInput,
    model: ResolvedVisualModel,
  ): Promise<PresentationSlideBrief> {
    validateVisualModel(model);
    const parsedInput = InputSchema.safeParse(uncheckedInput);
    if (!parsedInput.success) throw new SlideUnderstandingError();
    const input = parsedInput.data;

    let snapshot: ImageSnapshot | undefined;
    try {
      snapshot = await createImageSnapshot(input);
      const imageSha256 = sha256(snapshot.bytes);
      const extractedTextSha256 = sha256(input.extractedText);
      const target = path.join(
        input.projectPath,
        'presentations',
        input.presentationId,
        'analysis',
        pageName(input.pageNumber, 'json'),
      );
      const cached = await this.readCache(target, input);
      if (cached && isFresh(cached, input, imageSha256, extractedTextSha256, model)) {
        return cached;
      }

      const freshnessKey = [
        snapshot.bundlePath,
        input.pageNumber,
        imageSha256,
        extractedTextSha256,
        model.summary.entry_id,
        model.model,
        PRESENTATION_SLIDE_BRIEF_SCHEMA_VERSION,
        PRESENTATION_SLIDE_BRIEF_PROMPT_VERSION,
      ].join('\0');
      const current = this.inFlight.get(freshnessKey);
      if (current) return await current;

      const generated = this.generateBrief(
        input,
        snapshot.path,
        target,
        imageSha256,
        extractedTextSha256,
        model,
      );
      const tracked = generated.finally(() => {
        if (this.inFlight.get(freshnessKey) === tracked) this.inFlight.delete(freshnessKey);
      });
      this.inFlight.set(freshnessKey, tracked);
      return await tracked;
    } catch (error) {
      if (error instanceof SlideUnderstandingError) throw error;
      this.warnSafely(input, safeErrorName(error), 'Slide understanding failed');
      throw new SlideUnderstandingError();
    } finally {
      await snapshot?.cleanup().catch(() => undefined);
    }
  }

  private async generateBrief(
    input: EnsureSlideBriefInput,
    snapshotPath: string,
    target: string,
    imageSha256: string,
    extractedTextSha256: string,
    model: ResolvedVisualModel,
  ): Promise<PresentationSlideBrief> {
    try {
      const systemPrompt = await this.readPrompt();
      const output = await this.transport.generateWithImage({
        apiKey: model.apiKey,
        model: model.model,
        systemPrompt,
        userPrompt: [
          `Analyze slide ${input.pageNumber}.`,
          'Use the PNG as the visual source of truth. The exact extracted PDF text follows:',
          input.extractedText,
        ].join('\n'),
        imagePath: snapshotPath,
        imageMimeType: 'image/png',
        responseMimeType: 'application/json',
        maxTokens: SLIDE_MAX_TOKENS,
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
      await this.persist(target, `${JSON.stringify(brief, null, 2)}\n`);
      return brief;
    } catch (error) {
      this.warnSafely(input, safeErrorName(error), 'Slide understanding failed');
      throw new SlideUnderstandingError();
    }
  }
}
