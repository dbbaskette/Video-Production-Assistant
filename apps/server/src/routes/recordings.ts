import type { FastifyInstance, FastifyReply } from 'fastify';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, rename, rm, stat, writeFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { ProjectStore } from '../services/project/store.js';
import { ModelRouter, ModelRoutingError } from '../services/llm/model-router.js';
import { probeVideo, type VideoMetadata } from '../services/recording/metadata.js';
import { ingestRecording, type IngestResult } from '../services/recording/ingest.js';
import { loadStoryboard, saveStoryboard, createStoryboard, updateScene } from '../services/storyboard/index.js';
import { analyzeRecording, proposeSceneMetadataFromBrief } from '../services/video-analysis/index.js';
import {
  VideoUnderstandingService,
  videoUnderstandingErrorClass,
} from '../services/video-understanding/index.js';
import { proposeBoundaries } from '../services/recording/propose-boundaries.js';
import { splitRecording, type SceneBoundary } from '../services/recording/split.js';
import {
  RecordingProvenanceSchema,
  SceneSchema,
  SceneTransitionSchema,
  type ModelRoutingErrorCode,
  type RecordingProvenance,
  type ResolvedModelSummary,
  type Scene,
  type SceneTransition,
} from '@vpa/shared';
import { projectFiles } from '../services/project/paths.js';
import type { AgentRecordingCoordinator } from '../services/agent-recording/coordinator.js';
import { isAgentRecordingDomainError } from '../services/agent-recording/errors.js';
import {
  BULK_UPLOAD_MAX_FILE_BYTES,
  BULK_UPLOAD_MAX_FILES,
  StagedUploadError,
  cleanupBulkUploadStagingDirectory,
  createBulkUploadStagingDirectory,
  stageUploadStream,
  type StagedUpload,
} from '../services/recording/staged-upload.js';

interface Deps {
  store: ProjectStore;
  workspaceRoot: string;
  router: ModelRouter;
  videoUnderstanding: VideoUnderstandingService;
  /** Use fake ffprobe in test environments */
  probe?: typeof probeVideo;
  /** Test seam for recording persistence failures. */
  ingest?: typeof ingestRecording;
  agentRecordingCoordinator: Pick<
    AgentRecordingCoordinator,
    'recoverAttachment' | 'withManualUploadReservation'
  >;
  bulkUploadLimits?: { fileSizeBytes: number; fileCount: number };
}

type RecordingAnalysisResult =
  | {
      status: 'ready';
      model: ResolvedModelSummary;
      briefFreshness: 'generated' | 'reused';
    }
  | {
      status: 'failed';
      code: ModelRoutingErrorCode | 'video_analysis_failed';
      message: string;
    };

const VIDEO_ANALYSIS_FAILED_MESSAGE =
  'Video analysis failed. The recording is saved; try re-analyzing later.';

function privateAnalysisDiagnostic(error: unknown, sceneId: string): Record<string, unknown> {
  if (error instanceof ModelRoutingError) {
    return {
      sceneId,
      errorName: 'ModelRoutingError',
      code: error.code,
      role: error.role,
      scope: error.scope,
    };
  }
  return {
    sceneId,
    errorName: videoUnderstandingErrorClass(error),
  };
}

function publicAnalysisFailure(error: unknown): RecordingAnalysisResult {
  if (error instanceof ModelRoutingError) {
    return { status: 'failed', code: error.code, message: error.message };
  }
  return {
    status: 'failed',
    code: 'video_analysis_failed',
    message: VIDEO_ANALYSIS_FAILED_MESSAGE,
  };
}

async function resolveProjectPath(store: ProjectStore, projectId: string): Promise<string> {
  const tracker = await store.readTracker();
  const entry = tracker.projects.find((p) => p.id === projectId);
  if (!entry) throw { statusCode: 404, message: `Project not found: ${projectId}` };
  return entry.path;
}

async function resolveProjectEntry(store: ProjectStore, projectId: string) {
  const tracker = await store.readTracker();
  const entry = tracker.projects.find((p) => p.id === projectId);
  if (!entry) throw { statusCode: 404, message: `Project not found: ${projectId}` };
  return entry;
}

async function verifyManualIngestion(
  projectPath: string,
  sceneId: string,
  metadata: VideoMetadata,
  result: IngestResult,
  provenance: RecordingProvenance,
): Promise<void> {
  if (
    result.sceneId !== sceneId ||
    !result.relativePath ||
    result.metadata.duration_sec !== metadata.duration_sec ||
    result.metadata.width !== metadata.width ||
    result.metadata.height !== metadata.height ||
    result.metadata.codec !== metadata.codec ||
    result.metadata.fps !== metadata.fps ||
    result.metadata.size_bytes !== metadata.size_bytes
  ) {
    throw new Error('Recording ingestion returned inconsistent metadata.');
  }
  const storyboard = await loadStoryboard(projectPath);
  const recording = storyboard?.scenes.find((scene) => scene.id === sceneId)?.recording;
  if (
    !recording ||
    recording.source !== result.relativePath ||
    recording.duration_sec !== metadata.duration_sec ||
    recording.source_kind !== provenance.source_kind ||
    recording.capture_session_id !== provenance.capture_session_id ||
    recording.captured_at !== provenance.captured_at
  ) {
    throw new Error('Uploaded recording metadata could not be verified.');
  }
}

function sendUploadConflict(reply: FastifyReply, error: unknown) {
  if (isAgentRecordingDomainError(error) && error.code === 'CONFLICT') {
    return reply.status(409).send({
      error: 'Stop the active Cap recording workflow before uploading a recording manually.',
      code: 'agent_recording_active',
    });
  }
  throw error;
}

class InvalidBulkSceneMappingError extends Error {
  readonly code = 'invalid_scene_mapping';
}

function mapBulkScenes(scenes: Scene[], uploadCount: number): Scene[] {
  if (uploadCount > scenes.length) {
    throw new InvalidBulkSceneMappingError('Bulk upload has more files than scenes.');
  }
  const mapped = scenes.slice(0, uploadCount);
  const sceneIds = mapped.map((scene) => scene.id);
  if (
    sceneIds.some((sceneId) => !sceneId.trim()) ||
    new Set(sceneIds).size !== sceneIds.length
  ) {
    throw new InvalidBulkSceneMappingError('Bulk upload scene mapping is invalid.');
  }
  return mapped;
}

export async function registerRecordingRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { store, workspaceRoot, router, videoUnderstanding } = deps;
  const probe = deps.probe ?? probeVideo;
  const ingest = deps.ingest ?? ingestRecording;
  const bulkUploadLimits = deps.bulkUploadLimits ?? {
    fileSizeBytes: BULK_UPLOAD_MAX_FILE_BYTES,
    fileCount: BULK_UPLOAD_MAX_FILES,
  };
  const warnAnalysisFailure = (error: unknown, sceneId: string, message: string): void => {
    try {
      app.log.warn(privateAnalysisDiagnostic(error, sceneId), message);
    } catch {
      // Private diagnostics must never change attachment or analysis outcomes.
    }
  };

  const ensureRecordingBrief = async (
    projectId: string,
    projectPath: string,
    scene: Scene,
    result: IngestResult,
  ): Promise<RecordingAnalysisResult> => {
    try {
      const project = await store.readProject(projectId);
      const videoModel = await router.resolveVideo(project);
      const input = {
        projectPath,
        sceneId: scene.id,
        sceneName: scene.name,
        videoPath: path.join(projectPath, result.relativePath),
        videoMimeType: 'video/mp4',
      };
      const status = await videoUnderstanding.readBriefStatus(input, videoModel);
      await videoUnderstanding.ensureBrief(input, videoModel, (phase) => {
        app.log.info({ sceneId: scene.id, phase }, 'video understanding phase');
      });
      return {
        status: 'ready',
        model: videoModel.summary,
        briefFreshness: status.status === 'fresh' ? 'reused' : 'generated',
      };
    } catch (error) {
      warnAnalysisFailure(error, scene.id, 'Post-attachment video analysis failed');
      return publicAnalysisFailure(error);
    }
  };

  // POST /api/projects/:id/scenes/:sceneId/recording — upload recording for a specific scene
  app.post('/api/projects/:id/scenes/:sceneId/recording', async (req, reply) => {
    const { id, sceneId } = req.params as { id: string; sceneId: string };
    const projectPath = await resolveProjectPath(store, id);

    // Verify scene exists in storyboard
    const sb = await loadStoryboard(projectPath);
    if (!sb) {
      return reply.status(404).send({ error: 'No storyboard found', code: 'not_found' });
    }
    const scene = sb.scenes.find((candidate) => candidate.id === sceneId);
    if (!scene) {
      return reply.status(404).send({ error: `Scene not found: ${sceneId}`, code: 'scene_not_found' });
    }

    const data = await req.file();
    if (!data) {
      return reply.status(400).send({ error: 'No file uploaded', code: 'no_file' });
    }

    const multipartValue = (name: string): string | undefined => {
      const field = (data.fields as Record<string, { value?: unknown }> | undefined)?.[name];
      return typeof field?.value === 'string' ? field.value : undefined;
    };
    const provenance = RecordingProvenanceSchema.parse({
      source_kind: multipartValue('source_kind') ?? 'manual',
      capture_session_id: multipartValue('capture_session_id'),
      captured_at: multipartValue('captured_at'),
    });
    // Save to temp, probe, ingest, and verify while holding the coordinator's
    // exact scene reservation. Reading the request stream does not mutate disk.
    const chunks: Buffer[] = [];
    for await (const chunk of data.file) chunks.push(chunk);
    const upload = Buffer.concat(chunks);
    const tmpDir = path.join(projectPath, '.tmp');
    const tmpFile = path.join(tmpDir, `upload-${randomUUID()}.mp4`);

    try {
      let result: IngestResult;
      if (provenance.source_kind === 'cap-agent') {
        await mkdir(tmpDir, { recursive: true });
        await writeFile(tmpFile, upload);
        try {
          result = await deps.agentRecordingCoordinator.recoverAttachment(id, sceneId, provenance.capture_session_id!, {
            capturedAt: provenance.captured_at!, uploadedPath: tmpFile,
          });
        } catch {
          return reply.status(409).send({ error: 'Verified Cap attachment recovery was rejected.', code: 'invalid_capture_session' });
        }
      } else {
        try {
          result = await deps.agentRecordingCoordinator.withManualUploadReservation(
            id,
            [sceneId],
            async () => {
              await mkdir(tmpDir, { recursive: true });
              await writeFile(tmpFile, upload);
              const metadata = await probe(tmpFile);
              const ingested = await ingest(projectPath, sceneId, tmpFile, metadata, provenance);
              await verifyManualIngestion(projectPath, sceneId, metadata, ingested, provenance);
              return ingested;
            },
          );
        } catch (error) {
          return sendUploadConflict(reply, error);
        }
      }

      const attachment = {
        sceneId: result.sceneId,
        relativePath: result.relativePath,
        metadata: result.metadata,
      };
      const analysis = await ensureRecordingBrief(id, projectPath, scene, attachment);
      return reply.status(201).send({ ...attachment, analysis });
    } finally {
      await unlink(tmpFile).catch(() => {});
    }
  });

  // POST /api/projects/:id/recordings/bulk — upload multiple recordings
  app.post('/api/projects/:id/recordings/bulk', async (req, reply) => {
    const { id } = req.params as { id: string };
    const projectPath = await resolveProjectPath(store, id);

    const sb = await loadStoryboard(projectPath);
    if (!sb) {
      return reply.status(404).send({ error: 'No storyboard found', code: 'not_found' });
    }

    const stagingDirectory = await createBulkUploadStagingDirectory();
    let bulkError: unknown;
    try {
      const stagedUploads: StagedUpload[] = [];
      const parts = req.parts({
        limits: {
          fileSize: bulkUploadLimits.fileSizeBytes,
          files: bulkUploadLimits.fileCount,
        },
      });
      for await (const part of parts) {
        if (part.type !== 'file') continue;
        const staged = await stageUploadStream(
          path.join(stagingDirectory, `${randomUUID()}.mp4`),
          part.file,
          bulkUploadLimits.fileSizeBytes,
        );
        if (part.file.truncated) {
          throw new StagedUploadError('file_too_large', 'Uploaded file exceeds the byte limit.');
        }
        stagedUploads.push(staged);
      }
      const scenes = mapBulkScenes(sb.scenes, stagedUploads.length);
      if (scenes.length === 0) {
        return { results: [], assignedCount: 0, totalScenes: sb.scenes.length };
      }
      const provenance = RecordingProvenanceSchema.parse({ source_kind: 'bulk' });
      return await deps.agentRecordingCoordinator.withManualUploadReservation(
        id,
        scenes.map((scene) => scene.id),
        async () => {
          const results: IngestResult[] = [];
          for (let index = 0; index < scenes.length; index += 1) {
            const scene = scenes[index]!;
            const staged = stagedUploads[index]!;
            const metadata = await probe(staged.path);
            const result = await ingest(projectPath, scene.id, staged.path, metadata, provenance);
            await verifyManualIngestion(projectPath, scene.id, metadata, result, provenance);
            results.push(result);
          }
          return { results, assignedCount: results.length, totalScenes: sb.scenes.length };
        },
      );
    } catch (error) {
      bulkError = error;
    } finally {
      await cleanupBulkUploadStagingDirectory(stagingDirectory);
    }
    if (bulkError instanceof InvalidBulkSceneMappingError) {
      return reply.status(400).send({
        error: 'Bulk uploads must map once to existing scenes in order.',
        code: bulkError.code,
      });
    }
    if (
      bulkError instanceof StagedUploadError ||
      bulkError instanceof app.multipartErrors.RequestFileTooLargeError ||
      bulkError instanceof app.multipartErrors.FilesLimitError
    ) {
      return reply.status(413).send({
        error: 'Bulk upload exceeds the configured file size or count limit.',
        code: 'upload_limit_exceeded',
      });
    }
    return sendUploadConflict(reply, bulkError);
  });

  // GET /api/projects/:id/scenes/:sceneId/recording/video — stream the recording mp4.
  // Honors Range header so the browser video player can seek without
  // downloading the whole file.
  app.get('/api/projects/:id/scenes/:sceneId/recording/video', async (req, reply) => {
    const { id, sceneId } = req.params as { id: string; sceneId: string };
    const projectPath = await resolveProjectPath(store, id);

    const sb = await loadStoryboard(projectPath);
    if (!sb) return reply.status(404).send({ error: 'No storyboard found', code: 'not_found' });
    const scene = sb.scenes.find((s) => s.id === sceneId);
    if (!scene) return reply.status(404).send({ error: `Scene not found: ${sceneId}`, code: 'scene_not_found' });
    if (!scene.recording?.source) {
      return reply.status(404).send({ error: 'No recording for this scene', code: 'no_recording' });
    }

    const filePath = path.join(projectPath, scene.recording.source);
    let fileStat;
    try {
      fileStat = await stat(filePath);
    } catch {
      return reply.status(404).send({ error: 'Recording file missing on disk', code: 'file_missing' });
    }

    const total = fileStat.size;
    const range = req.headers.range;
    const ext = path.extname(filePath).toLowerCase();
    const mime = ext === '.mp4' ? 'video/mp4' : ext === '.mov' ? 'video/quicktime' : 'application/octet-stream';

    if (range) {
      const m = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (!m) {
        reply.header('Content-Range', `bytes */${total}`);
        return reply.status(416).send();
      }
      const start = Number.parseInt(m[1]!, 10);
      const end = m[2] && m[2].length > 0 ? Number.parseInt(m[2], 10) : total - 1;
      if (start >= total || end >= total || start > end) {
        reply.header('Content-Range', `bytes */${total}`);
        return reply.status(416).send();
      }
      reply.code(206);
      reply.header('Content-Type', mime);
      reply.header('Accept-Ranges', 'bytes');
      reply.header('Content-Range', `bytes ${start}-${end}/${total}`);
      reply.header('Content-Length', end - start + 1);
      return reply.send(createReadStream(filePath, { start, end }));
    }

    reply.header('Content-Type', mime);
    reply.header('Accept-Ranges', 'bytes');
    reply.header('Content-Length', total);
    return reply.send(createReadStream(filePath));
  });

  // GET /api/projects/:id/scenes/:sceneId/recording/metadata — get metadata for scene recording
  app.get('/api/projects/:id/scenes/:sceneId/recording/metadata', async (req, reply) => {
    const { id, sceneId } = req.params as { id: string; sceneId: string };
    const projectPath = await resolveProjectPath(store, id);

    const sb = await loadStoryboard(projectPath);
    if (!sb) {
      return reply.status(404).send({ error: 'No storyboard found', code: 'not_found' });
    }

    const scene = sb.scenes.find((s) => s.id === sceneId);
    if (!scene) {
      return reply.status(404).send({ error: `Scene not found: ${sceneId}`, code: 'scene_not_found' });
    }

    if (!scene.recording?.source) {
      return reply.status(404).send({ error: 'No recording for this scene', code: 'no_recording' });
    }

    const filePath = path.join(projectPath, scene.recording.source);
    const metadata = await probe(filePath);
    return metadata;
  });

  // POST /api/projects/:id/recordings/generate-storyboard — generate storyboard from uploaded recordings
  app.post('/api/projects/:id/recordings/generate-storyboard', async (req, reply) => {
    const { id } = req.params as { id: string };
    let project;
    try {
      project = await store.readProject(id);
    } catch {
      return reply.status(404).send({ error: `Project not found: ${id}`, code: 'not_found' });
    }
    const projectPath = project.path;

    // Expect multipart with one or more MP4 files
    const parts = req.parts();
    const uploadedFiles: Array<{ tmpFile: string; filename: string }> = [];

    const tmpDir = path.join(projectPath, '.tmp');
    await mkdir(tmpDir, { recursive: true });

    for await (const part of parts) {
      if (part.type !== 'file') continue;
      const tmpFile = path.join(tmpDir, `upload-${randomUUID()}.mp4`);
      const chunks: Buffer[] = [];
      for await (const chunk of part.file) {
        chunks.push(chunk);
      }
      await writeFile(tmpFile, Buffer.concat(chunks));
      uploadedFiles.push({ tmpFile, filename: part.filename });
    }

    if (uploadedFiles.length === 0) {
      return reply.status(400).send({ error: 'No files uploaded', code: 'no_files' });
    }

    let previousStoryboard: Awaited<ReturnType<typeof loadStoryboard>> | undefined;
    let transactionDir: string | undefined;
    const recordingBackups: Array<{ destination: string; backup?: string }> = [];
    let mutationStarted = false;
    try {
      const general = await router.resolveText('general', project);

      // Probe all files for metadata.
      const metadatas: VideoMetadata[] = [];
      for (const { tmpFile } of uploadedFiles) {
        metadatas.push(await probe(tmpFile));
      }

      // Analyze each recording to generate scene descriptions.
      const scenes: Scene[] = [];
      for (let i = 0; i < uploadedFiles.length; i++) {
        const analysis = await analyzeRecording(
          {
            filename: uploadedFiles[i]!.filename,
            duration_sec: metadatas[i]!.duration_sec,
            width: metadatas[i]!.width,
            height: metadatas[i]!.height,
            sceneIndex: i,
            totalScenes: uploadedFiles.length,
            projectObjective: project.objective,
            projectAudience: project.audience,
            projectPath: project.path,
          },
          general.client,
          workspaceRoot,
        );

        scenes.push(
          SceneSchema.parse({
            id: `scene-${String(i + 1).padStart(2, '0')}`,
            name: analysis.name,
            description: analysis.description,
            type: analysis.type,
          }),
        );
      }

      const storyboard = createStoryboard(project, scenes);
      const files = projectFiles(projectPath);
      previousStoryboard = await loadStoryboard(projectPath);
      transactionDir = path.join(tmpDir, `generate-storyboard-${randomUUID()}`);
      await mkdir(transactionDir, { recursive: true });
      await mkdir(files.recordingsDir, { recursive: true });
      for (const scene of scenes) {
        const destination = path.join(files.recordingsDir, `${scene.id}.mp4`);
        const backup = path.join(transactionDir, `${scene.id}.mp4`);
        try {
          await copyFile(destination, backup);
          recordingBackups.push({ destination, backup });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          recordingBackups.push({ destination });
        }
      }

      mutationStarted = true;
      await saveStoryboard(projectPath, storyboard);
      for (let i = 0; i < uploadedFiles.length; i++) {
        await ingest(projectPath, scenes[i]!.id, uploadedFiles[i]!.tmpFile, metadatas[i]!);
      }

      const generated = await loadStoryboard(projectPath);
      if (!generated) throw new Error('Generated storyboard could not be loaded.');
      return generated;
    } catch (error) {
      let rollbackFailed = false;
      if (mutationStarted) {
        for (const { destination, backup } of recordingBackups) {
          try {
            if (backup) await copyFile(backup, destination);
            else await unlink(destination).catch((unlinkError: NodeJS.ErrnoException) => {
              if (unlinkError.code !== 'ENOENT') throw unlinkError;
            });
          } catch {
            rollbackFailed = true;
          }
        }
        try {
          if (previousStoryboard) {
            await saveStoryboard(projectPath, previousStoryboard);
          } else {
            await unlink(projectFiles(projectPath).storyboard).catch((unlinkError: NodeJS.ErrnoException) => {
              if (unlinkError.code !== 'ENOENT') throw unlinkError;
            });
          }
        } catch {
          rollbackFailed = true;
        }
      }
      if (rollbackFailed) {
        req.log.error({ projectId: id, errorName: 'StoryboardRollbackError' }, 'Recording storyboard rollback was incomplete');
        return reply.status(500).send({
          error: 'Storyboard generation failed and cleanup was incomplete. Review the project recordings before retrying.',
          code: 'storyboard_rollback_failed',
        });
      }
      if (error instanceof ModelRoutingError) {
        return reply.status(error.statusCode).send({
          error: error.message,
          code: error.code,
          role: error.role,
        });
      }
      req.log.error({ projectId: id, errorName: 'StoryboardGenerationError' }, 'Recording storyboard generation failed');
      return reply.status(500).send({
        error: 'Storyboard generation failed. Your existing storyboard was not changed.',
        code: 'storyboard_generation_failed',
      });
    } finally {
      await Promise.all(uploadedFiles.map(({ tmpFile }) => unlink(tmpFile).catch(() => {})));
      if (transactionDir) await rm(transactionDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  // POST /api/projects/:id/recordings/propose-split — upload a single file, get AI-proposed scene boundaries
  app.post('/api/projects/:id/recordings/propose-split', async (req, reply) => {
    const { id } = req.params as { id: string };
    let project;
    try {
      project = await store.readProject(id);
    } catch {
      return reply.status(404).send({ error: `Project not found: ${id}`, code: 'not_found' });
    }
    const files = projectFiles(project.path);
    await mkdir(files.recordingsDir, { recursive: true });

    const data = await req.file();
    if (!data) {
      return reply.status(400).send({ error: 'No file uploaded', code: 'no_file' });
    }

    let general;
    try {
      general = await router.resolveText('general', project);
    } catch (error) {
      if (error instanceof ModelRoutingError) {
        return reply.status(error.statusCode).send({
          error: error.message,
          code: error.code,
          role: error.role,
        });
      }
      req.log.error({ projectId: id, errorName: 'BoundaryRoutingError' }, 'Recording boundary routing failed');
      return reply.status(503).send({
        error: 'The assigned model for general is unavailable. Check its configuration in project model settings.',
        code: 'model_unavailable',
        role: 'general',
      });
    }

    // Stage the upload and replace the durable source only after the model
    // returns valid boundaries. A provider failure preserves the prior source.
    const sourcePath = path.join(files.recordingsDir, '_source.mp4');
    const stagedSourcePath = path.join(files.recordingsDir, `._source-${randomUUID()}.mp4`);
    const chunks: Buffer[] = [];
    for await (const chunk of data.file) {
      chunks.push(chunk);
    }
    await writeFile(stagedSourcePath, Buffer.concat(chunks));

    try {
      const metadata = await probe(stagedSourcePath);
      const boundaries = await proposeBoundaries(
        { duration_sec: metadata.duration_sec, filename: '_source.mp4' },
        general.client,
        workspaceRoot,
      );
      await rename(stagedSourcePath, sourcePath);
      return { boundaries, sourceFile: '_source.mp4', metadata };
    } catch (error) {
      if (error instanceof ModelRoutingError) {
        return reply.status(error.statusCode).send({
          error: error.message,
          code: error.code,
          role: error.role,
        });
      }
      req.log.error({ projectId: id, errorName: 'BoundaryProposalError' }, 'Recording boundary proposal failed');
      return reply.status(500).send({
        error: 'Recording boundary proposal failed. Your existing source recording was not changed.',
        code: 'boundary_proposal_failed',
      });
    } finally {
      await unlink(stagedSourcePath).catch(() => {});
    }
  });

  // POST /api/projects/:id/recordings/execute-split — split source file at given boundaries
  app.post('/api/projects/:id/recordings/execute-split', async (req, reply) => {
    const { id } = req.params as { id: string };
    let project;
    try {
      project = await store.readProject(id);
    } catch {
      return reply.status(404).send({ error: `Project not found: ${id}`, code: 'not_found' });
    }
    const files = projectFiles(project.path);

    const body = req.body as { boundaries?: SceneBoundary[] } | null;
    if (!body?.boundaries || !Array.isArray(body.boundaries) || body.boundaries.length === 0) {
      return reply.status(400).send({ error: 'boundaries array is required', code: 'invalid_request' });
    }

    const sourcePath = path.join(files.recordingsDir, '_source.mp4');

    // Split into per-scene files
    const splitResults = await splitRecording(sourcePath, files.recordingsDir, body.boundaries);

    // Create scenes from boundaries
    const scenes: Scene[] = splitResults.map((r, i) => {
      const b = body.boundaries![i]!;
      return SceneSchema.parse({
        id: r.sceneId,
        name: b.suggested_name,
        description: `Split from source recording (${r.start_sec.toFixed(1)}s - ${r.end_sec.toFixed(1)}s)`,
        type: 'desktop',
      });
    });

    // Create and save storyboard
    const storyboard = createStoryboard(project, scenes);
    await saveStoryboard(project.path, storyboard);

    // Ingest each clip
    for (const sr of splitResults) {
      const clipPath = path.join(files.recordingsDir, `${sr.sceneId}.mp4`);
      const clipMeta: VideoMetadata = {
        duration_sec: sr.duration_sec,
        width: 0, height: 0,
        codec: 'h264', fps: 30,
        size_bytes: 0,
      };
      await ingestRecording(project.path, sr.sceneId, clipPath, clipMeta);
    }

    // Return final storyboard
    const finalSb = await loadStoryboard(project.path);
    return finalSb ?? storyboard;
  });

  // POST /api/projects/:id/scenes/:sceneId/analyze — re-run scene analysis
  // for an already-ingested recording. Lets the user refresh the scene's
  // name/description/type after adding source-docs or after an objective
  // change. Body: { groundInVideo?: boolean, dryRun?: boolean }.
  //
  // dryRun=true returns the proposed values without saving — used by the
  // UI to show a before/after diff and require explicit Apply before
  // overwriting whatever the user might have manually edited. Default
  // false preserves the prior behaviour.
  //
  // Grounded and text-only analysis are explicit, separate paths. Grounded
  // failures never fall back to metadata-only analysis.
  app.post('/api/projects/:id/scenes/:sceneId/analyze', async (req, reply) => {
    const { id, sceneId } = req.params as { id: string; sceneId: string };
    const body = (req.body ?? {}) as { groundInVideo?: boolean; dryRun?: boolean };

    const entry = await resolveProjectEntry(store, id);
    const sb = await loadStoryboard(entry.path);
    if (!sb) {
      return reply.status(404).send({ error: 'No storyboard found', code: 'not_found' });
    }
    const scene = sb.scenes.find((s) => s.id === sceneId);
    if (!scene) {
      return reply.status(404).send({ error: `Scene not found: ${sceneId}`, code: 'scene_not_found' });
    }
    if (!scene.recording?.source) {
      return reply.status(400).send({
        error: 'Scene has no recording — upload one first',
        code: 'no_recording',
      });
    }

    let proposal: Pick<Scene, 'name' | 'description' | 'type'>;
    let mode: 'text' | 'video' = 'text';
    try {
      const project = await store.readProject(entry.id);
      const analysisInput = {
        filename: scene.recording.source.split('/').pop() ?? scene.recording.source,
        duration_sec: scene.recording.duration_sec ?? 0,
        width: 0,
        height: 0,
        sceneIndex: sb.scenes.findIndex((candidate) => candidate.id === sceneId),
        totalScenes: sb.scenes.length,
        projectObjective: project.objective,
        projectAudience: project.audience,
        projectPath: entry.path,
      };
      try {
        const meta = await probe(path.join(entry.path, scene.recording.source));
        analysisInput.width = meta.width;
        analysisInput.height = meta.height;
      } catch {
        // Probe failure is non-fatal; text analysis can proceed with 0x0 and
        // grounded analysis obtains authoritative dimensions from its brief.
      }

      let analysis;
      if (body.groundInVideo === true) {
        mode = 'video';
        const videoModel = await router.resolveVideo(project);
        const brief = await videoUnderstanding.ensureBrief({
          projectPath: entry.path,
          sceneId,
          sceneName: scene.name,
          videoPath: path.join(entry.path, scene.recording.source),
          videoMimeType: 'video/mp4',
        }, videoModel, (phase) => {
          app.log.info({ sceneId, phase }, 'video-grounded analysis phase');
        });
        analysis = proposeSceneMetadataFromBrief(scene, brief);
      } else {
        const generalModel = await router.resolveText('general', project);
        analysis = await analyzeRecording(analysisInput, generalModel.client, workspaceRoot);
      }
      const validatedScene = SceneSchema.parse({ ...scene, ...analysis });
      proposal = {
        name: validatedScene.name,
        description: validatedScene.description,
        type: validatedScene.type,
      };
    } catch (error) {
      warnAnalysisFailure(error, sceneId, 'Scene re-analysis failed');
      if (error instanceof ModelRoutingError) {
        return reply.status(error.statusCode).send({
          error: error.message,
          code: error.code,
          role: error.role,
        });
      }
      return reply.status(500).send({
        error: VIDEO_ANALYSIS_FAILED_MESSAGE,
        code: 'video_analysis_failed',
      });
    }

    // dryRun: return proposed values + a snapshot of the current scene's
    // values so the UI can show a diff and require explicit Apply.
    if (body.dryRun) {
      return {
        sceneId,
        dryRun: true,
        proposed: proposal,
        current: {
          name: scene.name,
          description: scene.description,
          type: scene.type,
        },
        mode,
      };
    }

    // Persist the new name/description/type. Don't touch other scene
    // fields (recording, narration, lower_thirds, overlay_render, etc.).
    const updated = updateScene(sb, sceneId, {
      ...proposal,
    });
    await saveStoryboard(entry.path, updated);

    return {
      sceneId,
      ...proposal,
      mode,
    };
  });

  // PUT /api/projects/:id/scenes/:sceneId/metadata — apply a proposed
  // {name, description, type} to a scene. Used by the Re-analyze diff
  // UI to commit the LLM's suggestion only after the user has reviewed
  // it. Independent of the analyze route so the user can also use this
  // to manually edit the scene's metadata in the future.
  app.put('/api/projects/:id/scenes/:sceneId/metadata', async (req, reply) => {
    const { id, sceneId } = req.params as { id: string; sceneId: string };
    const body = (req.body ?? {}) as {
      name?: string;
      description?: string;
      type?: 'desktop' | 'terminal' | 'browser' | 'slide';
      transition?: SceneTransition | null;
      transition_duration_sec?: number | null;
      // Per-scene frame overrides. Either field can be:
      //   • a string (apply this value as the scene-level override)
      //   • null (clear the override — fall back to the project default)
      //   • undefined / missing (leave the existing value alone)
      frame_style?: string | null;
      frame_background?: string | null;
    };
    const entry = await resolveProjectEntry(store, id);
    const sb = await loadStoryboard(entry.path);
    if (!sb) {
      return reply.status(404).send({ error: 'No storyboard found', code: 'not_found' });
    }
    const scene = sb.scenes.find((s) => s.id === sceneId);
    if (!scene) {
      return reply.status(404).send({ error: `Scene not found: ${sceneId}`, code: 'scene_not_found' });
    }

    // Only update fields actually provided. Empty strings are honoured
    // for description (user might want to clear it); name has a min(1)
    // validation in SceneSchema so reject empty.
    const patch: Partial<typeof scene> = {};
    if (typeof body.name === 'string') {
      if (body.name.trim().length === 0) {
        return reply.status(400).send({ error: 'name cannot be empty', code: 'invalid_request' });
      }
      patch.name = body.name.trim();
    }
    if (typeof body.description === 'string') patch.description = body.description;
    if (body.type) patch.type = body.type;

    // Transition fields — `null` clears the value, undefined leaves it alone.
    if (body.transition !== undefined) {
      if (body.transition === null || body.transition === 'cut') {
        patch.transition = undefined;
        patch.transition_duration_sec = undefined;
      } else {
        const parsed = SceneTransitionSchema.safeParse(body.transition);
        if (!parsed.success) {
          return reply.status(400).send({ error: `invalid transition: ${body.transition}`, code: 'invalid_request' });
        }
        patch.transition = parsed.data;
      }
    }
    if (body.transition_duration_sec !== undefined) {
      if (body.transition_duration_sec === null) {
        patch.transition_duration_sec = undefined;
      } else if (
        typeof body.transition_duration_sec !== 'number' ||
        body.transition_duration_sec < 0.1 ||
        body.transition_duration_sec > 5
      ) {
        return reply.status(400).send({ error: 'transition_duration_sec must be 0.1–5', code: 'invalid_request' });
      } else {
        patch.transition_duration_sec = body.transition_duration_sec;
      }
    }

    // Frame style / background — `null` clears the per-scene override and
    // makes the scene fall back to the storyboard default; `undefined` leaves
    // the existing value alone.
    if (body.frame_style !== undefined) {
      patch.frame_style = body.frame_style === null ? undefined : body.frame_style;
    }
    if (body.frame_background !== undefined) {
      const bg = body.frame_background;
      if (bg === null) {
        patch.frame_background = undefined;
      } else if (bg === 'brand' || bg === 'transparent' || /^#[0-9a-fA-F]{6}$/.test(bg)) {
        patch.frame_background = bg as 'brand' | 'transparent' | `#${string}`;
      } else {
        return reply.status(400).send({
          error: 'frame_background must be "brand", "transparent", or a #RRGGBB hex',
          code: 'invalid_request',
        });
      }
    }

    const updated = updateScene(sb, sceneId, patch);
    await saveStoryboard(entry.path, updated);
    const next = updated.scenes.find((s) => s.id === sceneId);
    return {
      sceneId,
      name: next?.name,
      description: next?.description,
      type: next?.type,
      transition: next?.transition,
      transition_duration_sec: next?.transition_duration_sec,
      frame_style: next?.frame_style,
      frame_background: next?.frame_background,
    };
  });
}
