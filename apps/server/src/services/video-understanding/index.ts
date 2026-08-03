import {
  VIDEO_BRIEF_PROMPT_VERSION,
  VIDEO_BRIEF_SCHEMA_VERSION,
  VideoLowerThirdCandidateSchema,
  VideoNarrationCueSchema,
  VideoPacingCueSchema,
  VideoUnderstandingBriefSchema,
  VideoUnderstandingSegmentSchema,
  type VideoUnderstandingBrief,
} from '@vpa/shared';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { atomicWriteFile } from '../../lib/fs-atomic.js';
import type { ResolvedVideoModel } from '../llm/model-router.js';
import { probeVideo, sha256File, type VideoMetadata } from '../recording/metadata.js';
import { safeSceneDiagnosticFields } from '../../lib/safe-diagnostics.js';
import {
  deleteFile,
  generateWithVideo,
  uploadVideo,
  waitForFileActive,
  type GeminiFile,
  type GenerateWithVideoInput,
  type WaitForFileOptions,
} from '../video-narration/gemini-files.js';

const SAFE_SCENE_ID = /^[A-Za-z0-9_-]+$/;

const ModelProducedBriefSchema = z.object({
  visual_summary: z.string().min(1).max(4000),
  segments: z.array(VideoUnderstandingSegmentSchema).min(1).max(200),
  pacing_cues: z.array(VideoPacingCueSchema).max(100),
  narration_cues: z.array(VideoNarrationCueSchema).max(100),
  lower_third_candidates: z.array(VideoLowerThirdCandidateSchema).max(50),
}).strict();

export interface EnsureBriefInput {
  projectPath: string;
  sceneId: string;
  sceneName: string;
  videoPath: string;
  videoMimeType?: string;
}

export type VideoUnderstandingPhase =
  | 'hashing'
  | 'uploading'
  | 'processing'
  | 'analyzing'
  | 'validating'
  | 'saving'
  | 'done';

export type VideoUnderstandingPhaseCallback = (
  phase: VideoUnderstandingPhase,
  detail?: string,
) => void;

export type VideoUnderstandingBriefStatus =
  | { status: 'missing' }
  | { status: 'stale' }
  | { status: 'fresh'; brief: VideoUnderstandingBrief };

export type VideoUnderstandingWarning = (
  fields: Record<string, unknown>,
  message: string,
) => void;

interface VideoUnderstandingTransport {
  uploadVideo(
    apiKey: string,
    filePath: string,
    mimeType: string,
    displayName?: string,
  ): Promise<GeminiFile>;
  waitForFileActive(
    apiKey: string,
    fileName: string,
    opts?: WaitForFileOptions,
  ): Promise<GeminiFile>;
  generateWithVideo(input: GenerateWithVideoInput): Promise<string>;
  deleteFile(apiKey: string, fileName: string): Promise<boolean | void>;
}

export interface VideoUnderstandingServiceOptions {
  workspaceRoot: string;
  readTextFile?: (path: string) => Promise<string>;
  hashFile?: (path: string) => Promise<string>;
  probe?: (path: string) => Promise<VideoMetadata>;
  persist?: (path: string, data: string) => Promise<void>;
  readPrompt?: () => Promise<string>;
  transport?: VideoUnderstandingTransport;
  now?: () => Date;
  snapshotVideo?: (sourcePath: string) => Promise<VideoSnapshot>;
  cleanupTimeoutMs?: number;
  warn: VideoUnderstandingWarning;
}

export interface VideoSnapshot {
  path: string;
  cleanup(): Promise<void>;
}

export class VideoUnderstandingError extends Error {
  readonly code = 'video_analysis_failed';

  constructor(message = 'Video understanding failed.') {
    super(message);
    this.name = 'VideoUnderstandingError';
  }
}

function assertSafeSceneId(sceneId: string): void {
  if (!SAFE_SCENE_ID.test(sceneId)) {
    throw new VideoUnderstandingError('Scene ID contains unsupported characters.');
  }
}

function artifactPath(input: EnsureBriefInput): string {
  assertSafeSceneId(input.sceneId);
  return join(input.projectPath, 'analysis', 'video', `${input.sceneId}.json`);
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'ENOENT';
}

function isFresh(
  brief: VideoUnderstandingBrief,
  sceneId: string,
  sourceSha256: string,
  model: ResolvedVideoModel,
): boolean {
  return brief.scene_id === sceneId
    && brief.source.sha256 === sourceSha256
    && brief.model.entry_id === model.summary.entry_id
    && brief.model.provider === 'gemini'
    && brief.model.model === model.model
    && brief.schema_version === VIDEO_BRIEF_SCHEMA_VERSION
    && brief.prompt_version === VIDEO_BRIEF_PROMPT_VERSION;
}

function stripSingleJsonFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```json\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fenced?.[1]?.trim() ?? trimmed;
}

const VIDEO_UNDERSTANDING_ERROR_CLASSES = new Set([
  'CleanupRejected',
  'CleanupTimedOut',
  'Error',
  'ModelRoutingError',
  'UnknownError',
  'VideoUnderstandingError',
]);

async function snapshotVideo(sourcePath: string): Promise<VideoSnapshot> {
  const directory = await mkdtemp(join(tmpdir(), 'vpa-video-understanding-'));
  const snapshotPath = join(directory, 'recording.snapshot');
  try {
    await copyFile(sourcePath, snapshotPath);
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return {
    path: snapshotPath,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

export function videoUnderstandingErrorClass(error: unknown): string {
  if (error instanceof VideoUnderstandingError) return 'VideoUnderstandingError';
  return error instanceof Error ? 'Error' : 'UnknownError';
}

export function sanitizeVideoUnderstandingWarningFields(
  fields: Record<string, unknown>,
): Record<string, string> {
  const safe: Record<string, string> = {
    errorName: typeof fields.errorName === 'string'
      && VIDEO_UNDERSTANDING_ERROR_CLASSES.has(fields.errorName)
      ? fields.errorName
      : 'UnknownError',
  };
  Object.assign(safe, safeSceneDiagnosticFields(fields.sceneId));
  return safe;
}

export class VideoUnderstandingService {
  private readonly workspaceRoot: string;
  private readonly readTextFile: (path: string) => Promise<string>;
  private readonly hashFile: (path: string) => Promise<string>;
  private readonly probe: (path: string) => Promise<VideoMetadata>;
  private readonly persist: (path: string, data: string) => Promise<void>;
  private readonly readPrompt: () => Promise<string>;
  private readonly transport: VideoUnderstandingTransport;
  private readonly now: () => Date;
  private readonly snapshotVideo: (sourcePath: string) => Promise<VideoSnapshot>;
  private readonly cleanupTimeoutMs: number;
  private readonly warn: VideoUnderstandingWarning;
  private readonly inFlight = new Map<string, Promise<VideoUnderstandingBrief>>();

  constructor(options: VideoUnderstandingServiceOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.readTextFile = options.readTextFile ?? ((path) => readFile(path, 'utf8'));
    this.hashFile = options.hashFile ?? sha256File;
    this.probe = options.probe ?? probeVideo;
    this.persist = options.persist ?? atomicWriteFile;
    this.readPrompt = options.readPrompt
      ?? (() => this.readTextFile(join(this.workspaceRoot, 'apps', 'server', 'prompts', 'video-understanding.md')));
    this.transport = options.transport ?? {
      uploadVideo,
      waitForFileActive,
      generateWithVideo,
      deleteFile,
    };
    this.now = options.now ?? (() => new Date());
    this.snapshotVideo = options.snapshotVideo ?? snapshotVideo;
    this.cleanupTimeoutMs = options.cleanupTimeoutMs ?? 5_000;
    this.warn = options.warn;
  }

  private warnSafely(fields: Record<string, unknown>, message: string): void {
    try {
      this.warn(fields, message);
    } catch {
      // Diagnostics must never change the analysis or cleanup outcome.
    }
  }

  async readBriefStatus(
    input: EnsureBriefInput,
    model: ResolvedVideoModel,
  ): Promise<VideoUnderstandingBriefStatus> {
    assertSafeSceneId(input.sceneId);
    let snapshot: VideoSnapshot | undefined;
    try {
      snapshot = await this.snapshotVideo(input.videoPath);
      const sourceSha256 = await this.hashFile(snapshot.path);
      return await this.readBriefStatusForHash(input, model, sourceSha256);
    } catch (error) {
      if (error instanceof VideoUnderstandingError) throw error;
      throw new VideoUnderstandingError('Unable to fingerprint video for analysis.');
    } finally {
      await snapshot?.cleanup().catch(() => undefined);
    }
  }

  async ensureBrief(
    input: EnsureBriefInput,
    model: ResolvedVideoModel,
    onPhase?: VideoUnderstandingPhaseCallback,
  ): Promise<VideoUnderstandingBrief> {
    assertSafeSceneId(input.sceneId);
    onPhase?.('hashing');

    let snapshot: VideoSnapshot | undefined;
    try {
      snapshot = await this.snapshotVideo(input.videoPath);
      const sourceSha256 = await this.hashFile(snapshot.path);

      const status = await this.readBriefStatusForHash(input, model, sourceSha256);
      if (status.status === 'fresh') {
        onPhase?.('done');
        return status.brief;
      }

      const key = [
        input.projectPath,
        input.sceneId,
        sourceSha256,
        model.summary.entry_id,
        model.model,
        VIDEO_BRIEF_SCHEMA_VERSION,
        VIDEO_BRIEF_PROMPT_VERSION,
      ].join('\0');

      const existing = this.inFlight.get(key);
      if (existing) return await existing;

      const generated = this.generateBrief(input, snapshot.path, model, sourceSha256, onPhase);
      const tracked = generated.finally(() => {
        this.inFlight.delete(key);
      });
      this.inFlight.set(key, tracked);
      return await tracked;
    } catch (error) {
      if (error instanceof VideoUnderstandingError) throw error;
      throw new VideoUnderstandingError('Unable to fingerprint video for analysis.');
    } finally {
      await snapshot?.cleanup().catch(() => undefined);
    }
  }

  private async readBriefStatusForHash(
    input: EnsureBriefInput,
    model: ResolvedVideoModel,
    sourceSha256: string,
  ): Promise<VideoUnderstandingBriefStatus> {
    let raw: string;
    try {
      raw = await this.readTextFile(artifactPath(input));
    } catch (error) {
      if (isMissingFile(error)) return { status: 'missing' };
      throw new VideoUnderstandingError('Unable to read the saved video brief.');
    }

    try {
      const brief = VideoUnderstandingBriefSchema.parse(JSON.parse(raw));
      return isFresh(brief, input.sceneId, sourceSha256, model)
        ? { status: 'fresh', brief }
        : { status: 'stale' };
    } catch {
      return { status: 'stale' };
    }
  }

  private async generateBrief(
    input: EnsureBriefInput,
    snapshotPath: string,
    model: ResolvedVideoModel,
    sourceSha256: string,
    onPhase?: VideoUnderstandingPhaseCallback,
  ): Promise<VideoUnderstandingBrief> {
    const mimeType = input.videoMimeType ?? 'video/mp4';
    let uploaded: GeminiFile | undefined;

    try {
      const [metadata, systemPrompt] = await Promise.all([
        this.probe(snapshotPath),
        this.readPrompt(),
      ]);

      onPhase?.('uploading');
      uploaded = await this.transport.uploadVideo(
        model.apiKey,
        snapshotPath,
        mimeType,
        `${input.sceneId} recording`,
      );

      onPhase?.('processing');
      const active = await this.transport.waitForFileActive(model.apiKey, uploaded.name, {
        onPoll: (state) => {
          if (state !== 'ACTIVE') onPhase?.('processing', state);
        },
      });

      onPhase?.('analyzing');
      const output = await this.transport.generateWithVideo({
        apiKey: model.apiKey,
        model: model.model,
        systemPrompt,
        userPrompt: [
          `Scene name: ${JSON.stringify(input.sceneName)}`,
          `Exact video duration: ${metadata.duration_sec} seconds`,
          `Video dimensions: ${metadata.width}x${metadata.height}`,
          'Analyze the supplied video and return the requested JSON object only.',
        ].join('\n'),
        videoFileUri: active.uri,
        videoMimeType: mimeType,
        temperature: 0.2,
        responseMimeType: 'application/json',
      });

      onPhase?.('validating');
      const modelFields = ModelProducedBriefSchema.parse(
        JSON.parse(stripSingleJsonFence(output)),
      );
      const brief = VideoUnderstandingBriefSchema.parse({
        schema_version: VIDEO_BRIEF_SCHEMA_VERSION,
        prompt_version: VIDEO_BRIEF_PROMPT_VERSION,
        scene_id: input.sceneId,
        source: {
          path: input.videoPath,
          sha256: sourceSha256,
          duration_sec: metadata.duration_sec,
          width: metadata.width,
          height: metadata.height,
        },
        model: {
          entry_id: model.summary.entry_id,
          provider: 'gemini',
          model: model.model,
        },
        created_at: this.now().toISOString(),
        ...modelFields,
      });

      onPhase?.('saving');
      await this.persist(artifactPath(input), `${JSON.stringify(brief, null, 2)}\n`);
      onPhase?.('done');
      return brief;
    } catch (error) {
      if (error instanceof VideoUnderstandingError) throw error;
      this.warnSafely(
        { sceneId: input.sceneId, errorName: videoUnderstandingErrorClass(error) },
        'Video understanding failed',
      );
      throw new VideoUnderstandingError();
    } finally {
      if (uploaded) {
        await this.cleanupRemoteFile(input.sceneId, model.apiKey, uploaded.name);
      }
    }
  }

  private async cleanupRemoteFile(sceneId: string, apiKey: string, fileName: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<{ status: 'timeout' }>((resolve) => {
      timer = setTimeout(() => resolve({ status: 'timeout' }), this.cleanupTimeoutMs);
      timer.unref?.();
    });
    const cleanup = Promise.resolve()
      .then(() => this.transport.deleteFile(apiKey, fileName))
      .then(
        (deleted) => ({ status: 'settled' as const, deleted }),
        (error: unknown) => ({ status: 'rejected' as const, error }),
      );
    const result = await Promise.race([cleanup, timeout]);
    if (timer) clearTimeout(timer);

    if (result.status === 'timeout') {
      this.warnSafely(
        { sceneId, errorName: 'CleanupTimedOut' },
        'Gemini video cleanup failed',
      );
    } else if (result.status === 'rejected') {
      this.warnSafely(
        { sceneId, errorName: videoUnderstandingErrorClass(result.error) },
        'Gemini video cleanup failed',
      );
    } else if (result.deleted === false) {
      this.warnSafely(
        { sceneId, errorName: 'CleanupRejected' },
        'Gemini video cleanup failed',
      );
    }
  }
}
