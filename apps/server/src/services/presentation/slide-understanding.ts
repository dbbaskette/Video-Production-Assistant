import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rename,
  rmdir,
  unlink,
} from 'node:fs/promises';
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

const InputSchema = z.object({
  projectPath: z.string().min(1).max(MAX_PROJECT_PATH_CHARS),
  presentationId: z.string().uuid(),
  pageNumber: z.number().int().positive().max(200),
  imagePath: z.string().min(1).max(MAX_PROJECT_PATH_CHARS),
  extractedText: z.string().max(MAX_EXTRACTED_TEXT_CHARS),
}).strict();

const NonWhitespaceItemSchema = z.string().min(1).max(1_000).refine(
  (value) => value.trim().length > 0,
  'Item must contain non-whitespace content',
);
const BriefListSchema = z.array(NonWhitespaceItemSchema).max(50);
const ModelProducedBriefSchema = z.object({
  visual_summary: z.string().min(1).max(4_000).refine(
    (value) => value.trim().length > 0,
    'visual_summary must contain non-whitespace content',
  ),
  detected_title: z.string().max(200).refine(
    (value) => value.length === 0 || value.trim().length > 0,
    'detected_title must be empty or contain non-whitespace content',
  ),
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
  readTextFile?: (path: string, maxBytes: number) => Promise<string>;
  persist?: (path: string, data: string) => Promise<void>;
  writeSnapshot?: (path: string, bytes: Buffer) => Promise<void>;
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

interface ImageSnapshot {
  path: string;
  directory: DirectoryIdentity;
  file: FileIdentity;
  imageSha256: string;
  assertCurrent(): Promise<void>;
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

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function currentIdentity(target: string): Promise<FileIdentity & {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}> {
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
  if (!path.isAbsolute(target) || path.resolve(target) !== target) throw new SlideUnderstandingError();
  await assertNoSymlinkAncestors(target);
  if (await realpath(target) !== target) throw new SlideUnderstandingError();
  const stat = await currentIdentity(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new SlideUnderstandingError();
  return { path: target, dev: stat.dev, ino: stat.ino };
}

async function assertDirectoryIdentity(expected: DirectoryIdentity): Promise<void> {
  const stat = await currentIdentity(expected.path);
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || !sameIdentity(stat, expected)
    || await realpath(expected.path) !== expected.path
  ) {
    throw new SlideUnderstandingError();
  }
}

async function assertFileIdentity(target: string, expected: FileIdentity): Promise<void> {
  const stat = await currentIdentity(target);
  if (!stat.isFile() || stat.isSymbolicLink() || !sameIdentity(stat, expected)) {
    throw new SlideUnderstandingError();
  }
}

async function resolveBundlePaths(input: EnsureSlideBriefInput): Promise<BundlePaths> {
  const projectPath = path.resolve(input.projectPath);
  if (projectPath !== input.projectPath) throw new SlideUnderstandingError();
  const project = await canonicalDirectory(projectPath);
  const bundlePath = path.join(project.path, 'presentations', input.presentationId);
  const bundle = await canonicalDirectory(bundlePath);
  const pages = await canonicalDirectory(path.join(bundle.path, 'pages'));
  const imagePath = path.join(pages.path, pageName(input.pageNumber, 'png'));
  if (input.imagePath !== imagePath) throw new SlideUnderstandingError();

  const imageStat = await currentIdentity(imagePath);
  if (!imageStat.isFile() || imageStat.isSymbolicLink() || await realpath(imagePath) !== imagePath) {
    throw new SlideUnderstandingError();
  }

  const analysisPath = path.join(bundle.path, 'analysis');
  await mkdir(analysisPath, { recursive: true });
  const analysis = await canonicalDirectory(analysisPath);
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

async function writeOwnedFile(target: string, bytes: Buffer, mode: number): Promise<FileIdentity> {
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  const handle = await open(
    target,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
    mode,
  );
  let identity: FileIdentity | undefined;
  let failure: unknown;
  try {
    try {
      await handle.writeFile(bytes);
      const stat = await handle.stat({ bigint: true });
      identity = { dev: stat.dev, ino: stat.ino };
    } catch (error) {
      const failedStat = await handle.stat({ bigint: true }).catch(() => undefined);
      if (failedStat) identity = { dev: failedStat.dev, ino: failedStat.ino };
      failure = error;
    }
  } finally {
    await handle.close();
  }
  if (failure) {
    if (identity) {
      try {
        await assertFileIdentity(target, identity);
        await unlink(target);
      } catch {
        // Preserve a replacement whose identity changed.
      }
    }
    throw failure;
  }
  return identity!;
}

async function removeOwnedSnapshotCreation(
  directory: DirectoryIdentity,
  snapshotPath: string,
  file?: FileIdentity,
): Promise<void> {
  try {
    await assertDirectoryIdentity(directory);
  } catch {
    return;
  }
  if (file) {
    try {
      await assertFileIdentity(snapshotPath, file);
      await unlink(snapshotPath);
    } catch {
      return;
    }
  } else {
    try {
      await lstat(snapshotPath);
      return;
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') return;
    }
  }
  try {
    await assertDirectoryIdentity(directory);
    await rmdir(directory.path);
  } catch {
    // A changed or non-empty directory is intentionally preserved.
  }
}

async function createImageSnapshot(
  paths: BundlePaths,
  injectedWrite?: (path: string, bytes: Buffer) => Promise<void>,
): Promise<ImageSnapshot> {
  await assertDirectoryIdentity(paths.project);
  await assertDirectoryIdentity(paths.bundle);
  await assertDirectoryIdentity(paths.pages);
  const bytes = await readBoundedFileNoFollow(paths.imagePath, MAX_INLINE_IMAGE_BYTES);
  await assertDirectoryIdentity(paths.pages);
  if (bytes.byteLength === 0) throw new SlideUnderstandingError();
  const imageSha256 = sha256(bytes);

  await assertDirectoryIdentity(paths.analysis);
  const directoryPath = await mkdtemp(path.join(paths.analysis.path, '.slide-understanding-'));
  const directory = await canonicalDirectory(directoryPath);
  await assertDirectoryIdentity(paths.analysis);
  const snapshotPath = path.join(directory.path, `${randomUUID()}.png`);
  let file: FileIdentity | undefined;
  try {
    if (injectedWrite) {
      await injectedWrite(snapshotPath, bytes);
      const stat = await currentIdentity(snapshotPath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new SlideUnderstandingError();
      file = { dev: stat.dev, ino: stat.ino };
    } else {
      file = await writeOwnedFile(snapshotPath, bytes, 0o400);
    }
    await assertDirectoryIdentity(paths.analysis);
    await assertDirectoryIdentity(directory);
    await assertFileIdentity(snapshotPath, file);
  } catch (error) {
    await removeOwnedSnapshotCreation(directory, snapshotPath, file);
    throw error;
  }

  const snapshot: ImageSnapshot = {
    path: snapshotPath,
    directory,
    file,
    imageSha256,
    async assertCurrent() {
      await assertDirectoryIdentity(paths.analysis);
      await assertDirectoryIdentity(directory);
      await assertFileIdentity(snapshotPath, file);
      if (await realpath(snapshotPath) !== snapshotPath) throw new SlideUnderstandingError();
    },
    async cleanup() {
      try {
        await assertDirectoryIdentity(directory);
      } catch {
        return;
      }
      try {
        await assertFileIdentity(snapshotPath, file);
      } catch (error) {
        if (errorCode(error) === 'ENOENT') {
          try {
            await assertDirectoryIdentity(directory);
            await rmdir(directory.path);
          } catch {
            // A changed or non-empty directory is intentionally preserved.
          }
        }
        return;
      }
      try {
        await unlink(snapshotPath);
      } catch {
        return;
      }
      try {
        await assertDirectoryIdentity(directory);
        await rmdir(directory.path);
      } catch {
        // A changed or non-empty directory is intentionally preserved.
      }
    },
  };
  return snapshot;
}

function validateVisualModel(model: ResolvedVisualModel): void {
  const summary = model?.summary;
  if (
    !model
    || !summary
    || summary.role !== 'video-understanding'
    || summary.provider !== 'gemini'
    || summary.ready !== true
    || summary.capabilities?.image !== true
    || summary.model !== model.model
    || !isValidGeminiTransportIdentity({
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

function freshnessKey(fields: {
  bundlePath: string;
  pageNumber: number;
  imageSha256: string;
  extractedTextSha256: string;
  entryId: string;
  model: string;
}): string {
  return JSON.stringify({
    bundlePath: fields.bundlePath,
    pageNumber: fields.pageNumber,
    imageSha256: fields.imageSha256,
    extractedTextSha256: fields.extractedTextSha256,
    entryId: fields.entryId,
    model: fields.model,
    schemaVersion: PRESENTATION_SLIDE_BRIEF_SCHEMA_VERSION,
    promptVersion: PRESENTATION_SLIDE_BRIEF_PROMPT_VERSION,
  });
}

async function atomicWriteContained(
  target: string,
  data: string,
  parent: DirectoryIdentity,
): Promise<void> {
  if (Buffer.byteLength(data, 'utf8') > MAX_ARTIFACT_BYTES) throw new SlideUnderstandingError();
  await assertDirectoryIdentity(parent);
  const temporary = path.join(parent.path, `.${path.basename(target)}.${randomUUID()}.tmp`);
  const temporaryIdentity = await writeOwnedFile(temporary, Buffer.from(data, 'utf8'), 0o600);
  try {
    await assertDirectoryIdentity(parent);
    await assertFileIdentity(temporary, temporaryIdentity);
    await rename(temporary, target);
    await assertDirectoryIdentity(parent);
    await assertFileIdentity(target, temporaryIdentity);
  } catch (error) {
    try {
      await assertDirectoryIdentity(parent);
      await assertFileIdentity(temporary, temporaryIdentity);
      await unlink(temporary);
    } catch {
      // Never remove a path whose directory or file identity changed.
    }
    throw error;
  }
}

export class SlideUnderstandingService {
  private readonly transport: GeminiImageTransportLike;
  private readonly readPrompt: () => Promise<string>;
  private readonly readTextFile: (path: string, maxBytes: number) => Promise<string>;
  private readonly persist?: (path: string, data: string) => Promise<void>;
  private readonly writeSnapshot?: (path: string, bytes: Buffer) => Promise<void>;
  private readonly warn: SlideUnderstandingWarning;
  private readonly inFlight = new Map<string, Promise<PresentationSlideBrief>>();
  private readonly targetGeneration = new Map<string, number>();
  private readonly latestCompletedGeneration = new Map<string, number>();
  private readonly writeTails = new Map<string, Promise<void>>();

  constructor(options: SlideUnderstandingServiceOptions) {
    this.transport = options.transport ?? new GeminiImageTransport();
    this.readPrompt = options.readPrompt ?? (() => readBoundedTextNoFollow(path.join(
      options.workspaceRoot,
      'apps',
      'server',
      'prompts',
      'presentation-slide-understanding.md',
    ), MAX_PROMPT_BYTES));
    this.readTextFile = options.readTextFile ?? readBoundedTextNoFollow;
    this.persist = options.persist;
    this.writeSnapshot = options.writeSnapshot;
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
    paths: BundlePaths,
    input: EnsureSlideBriefInput,
  ): Promise<PresentationSlideBrief | undefined> {
    await assertDirectoryIdentity(paths.analysis);
    let raw: string;
    try {
      raw = await this.readTextFile(paths.artifactPath, MAX_CACHE_BYTES);
    } catch (error) {
      await assertDirectoryIdentity(paths.analysis);
      if (errorCode(error) === 'ENOENT') return undefined;
      this.warnSafely(input, 'UnreadableSlideBriefCache', 'Regenerating unreadable slide brief cache');
      return undefined;
    }
    await assertDirectoryIdentity(paths.analysis);
    if (Buffer.byteLength(raw, 'utf8') > MAX_CACHE_BYTES) {
      this.warnSafely(input, 'UnreadableSlideBriefCache', 'Regenerating unreadable slide brief cache');
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

  private nextGeneration(target: string): number {
    const next = (this.targetGeneration.get(target) ?? 0) + 1;
    this.targetGeneration.set(target, next);
    return next;
  }

  private markCompleted(target: string, generation: number): void {
    this.latestCompletedGeneration.set(
      target,
      Math.max(this.latestCompletedGeneration.get(target) ?? 0, generation),
    );
  }

  private async persistIfLatest(
    paths: BundlePaths,
    generation: number,
    data: string,
  ): Promise<void> {
    const target = paths.artifactPath;
    const previous = this.writeTails.get(target) ?? Promise.resolve();
    const write = previous.catch(() => undefined).then(async () => {
      if (this.latestCompletedGeneration.get(target) !== generation) return;
      await assertDirectoryIdentity(paths.analysis);
      if (this.persist) {
        await this.persist(target, data);
        await assertDirectoryIdentity(paths.analysis);
      } else {
        await atomicWriteContained(target, data, paths.analysis);
      }
    });
    const tracked = write.finally(() => {
      if (this.writeTails.get(target) === tracked) this.writeTails.delete(target);
    });
    this.writeTails.set(target, tracked);
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

    let snapshot: ImageSnapshot | undefined;
    try {
      const paths = await resolveBundlePaths(input);
      snapshot = await createImageSnapshot(paths, this.writeSnapshot);
      const extractedTextSha256 = sha256(input.extractedText);
      const cached = await this.readCache(paths, input);
      if (cached && isFresh(cached, input, snapshot.imageSha256, extractedTextSha256, model)) {
        return cached;
      }

      const key = freshnessKey({
        bundlePath: paths.bundle.path,
        pageNumber: input.pageNumber,
        imageSha256: snapshot.imageSha256,
        extractedTextSha256,
        entryId: model.summary.entry_id,
        model: model.model,
      });
      const current = this.inFlight.get(key);
      if (current) {
        const losingSnapshot = snapshot;
        snapshot = undefined;
        await losingSnapshot.cleanup();
        return await current;
      }

      const generation = this.nextGeneration(paths.artifactPath);
      const generated = this.generateBrief(
        input,
        paths,
        snapshot,
        extractedTextSha256,
        model,
        generation,
      );
      const tracked = generated.finally(() => {
        if (this.inFlight.get(key) === tracked) this.inFlight.delete(key);
      });
      this.inFlight.set(key, tracked);
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
    paths: BundlePaths,
    snapshot: ImageSnapshot,
    extractedTextSha256: string,
    model: ResolvedVisualModel,
    generation: number,
  ): Promise<PresentationSlideBrief> {
    try {
      const systemPrompt = await this.readPrompt();
      if (
        Buffer.byteLength(systemPrompt, 'utf8') > MAX_PROMPT_BYTES
        || systemPrompt.trim().length === 0
      ) {
        throw new SlideUnderstandingError();
      }
      await snapshot.assertCurrent();
      const output = await this.transport.generateWithImage({
        apiKey: model.apiKey,
        model: model.model,
        systemPrompt,
        userPrompt: [
          `Analyze slide ${input.pageNumber}.`,
          'Use the PNG as the visual source of truth. The exact extracted PDF text follows:',
          input.extractedText,
        ].join('\n'),
        imagePath: snapshot.path,
        imageMimeType: 'image/png',
        responseMimeType: 'application/json',
        maxTokens: SLIDE_MAX_TOKENS,
        expectedImageSha256: snapshot.imageSha256,
      });
      await snapshot.assertCurrent();
      const modelFields = ModelProducedBriefSchema.parse(parseSingleJsonObject(output));
      const brief = PresentationSlideBriefSchema.parse({
        schema_version: PRESENTATION_SLIDE_BRIEF_SCHEMA_VERSION,
        presentation_id: input.presentationId,
        page_number: input.pageNumber,
        image_sha256: snapshot.imageSha256,
        extracted_text_sha256: extractedTextSha256,
        model: {
          entry_id: model.summary.entry_id,
          provider: 'gemini',
          model: model.model,
        },
        prompt_version: PRESENTATION_SLIDE_BRIEF_PROMPT_VERSION,
        ...modelFields,
      });
      this.markCompleted(paths.artifactPath, generation);
      await this.persistIfLatest(paths, generation, `${JSON.stringify(brief, null, 2)}\n`);
      return brief;
    } catch (error) {
      this.warnSafely(input, safeErrorName(error), 'Slide understanding failed');
      throw new SlideUnderstandingError();
    }
  }
}
