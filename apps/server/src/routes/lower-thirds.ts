import { join } from 'node:path';
import { unlink } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ProjectStore } from '../services/project/store.js';
import { ModelRouter, ModelRoutingError } from '../services/llm/model-router.js';
import { loadStoryboard, saveStoryboard } from '../services/storyboard/index.js';
import { recommendLowerThirds } from '../services/lower-thirds/index.js';
import { recommendLowerThirdsFromBrief } from '../services/lower-thirds/video-grounded.js';
import { VideoUnderstandingService } from '../services/video-understanding/index.js';
import { sha256File } from '../services/recording/metadata.js';
import {
  LowerThirdSchema,
  type LowerThird,
  type ResolvedModelSummary,
  type Scene,
  type Storyboard,
} from '@vpa/shared';

const LowerThirdSetSchema = z.array(LowerThirdSchema).min(1).max(5);
const RecommendBodySchema = z.object({
  groundInVideo: z.boolean().optional(),
}).strict();
const VIDEO_LOWER_THIRDS_FAILED_MESSAGE =
  'Video-grounded lower-third recommendation failed. Your existing lower thirds were not changed.';
const LOWER_THIRDS_FAILED_MESSAGE =
  'Lower-third recommendation failed. Your existing lower thirds were not changed.';

type RecommendationStage = 'preparing' | 'routing' | 'video-understanding' | 'writing' | 'persistence';

function privateRecommendationDiagnostic(
  error: unknown,
  sceneId: string,
  stage: RecommendationStage,
): Record<string, unknown> {
  if (error instanceof ModelRoutingError) {
    return {
      sceneId,
      stage,
      errorName: 'ModelRoutingError',
      code: error.code,
      role: error.role,
      scope: error.scope,
    };
  }
  return { sceneId, stage, errorName: 'RecommendationError' };
}

function modelOperationFields(
  sceneId: string,
  summary: ResolvedModelSummary,
  phase: string,
  briefFreshness?: 'generated' | 'reused',
): Record<string, unknown> {
  return {
    sceneId,
    operation: 'lower-third-recommendation',
    phase,
    role: summary.role,
    entryId: summary.entry_id,
    provider: summary.provider,
    model: summary.model,
    ...(briefFreshness ? { briefFreshness } : {}),
  };
}

/**
 * Replace a scene's lower_thirds AND invalidate the caches that depend on
 * them — the baked `overlay_render` video (LTs burned in) and the
 * `frame_render` video downstream of it. Both are kept on disk to speed up
 * subsequent renders; their freshness is checked by existence only, not
 * content, so we have to drop them whenever the LT data is replaced.
 * Without this, the next render reuses the cached overlay and the user
 * sees the LTs they just deleted.
 */
function updateLowerThirds(
  sb: Storyboard,
  scene: Scene,
  lowerThirds: LowerThird[],
): Storyboard {
  // Build the replacement scene with the cache pointers stripped — we can't
  // pass `undefined` through updateScene because the YAML dump trips on
  // explicit undefined values.
  const { overlay_render: _o, frame_render: _f, ...rest } = scene;
  void _o; void _f;
  const replacement: Scene = { ...rest, lower_thirds: lowerThirds };
  const scenes = sb.scenes.map((s) => (s.id === scene.id ? replacement : s));
  return { ...sb, scenes };
}

async function cleanupLowerThirdArtifacts(
  projectPath: string,
  scene: Scene,
  removeArtifact: (path: string) => Promise<void>,
): Promise<void> {
  const artifacts = [scene.overlay_render, scene.frame_render].filter(
    (value): value is string => Boolean(value),
  );
  await Promise.all(artifacts.map(async (artifact) => {
    try {
      await removeArtifact(join(projectPath, artifact));
    } catch {
      // The pointer-free storyboard is already durable. Stale cache files are
      // harmless and can be cleaned up by a later render or maintenance pass.
    }
  }));
}

interface Deps {
  store: ProjectStore;
  workspaceRoot: string;
  router: ModelRouter;
  videoUnderstanding: VideoUnderstandingService;
  fingerprintRecording?: (path: string) => Promise<string>;
  persistStoryboard?: typeof saveStoryboard;
  removeArtifact?: (path: string) => Promise<void>;
}

async function resolveProjectPath(store: ProjectStore, projectId: string): Promise<string> {
  const tracker = await store.readTracker();
  const entry = tracker.projects.find((p) => p.id === projectId);
  if (!entry) throw { statusCode: 404, message: `Project not found: ${projectId}` };
  return entry.path;
}

export async function registerLowerThirdsRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const {
    store,
    workspaceRoot,
    router,
    videoUnderstanding,
    fingerprintRecording = sha256File,
    persistStoryboard = saveStoryboard,
    removeArtifact = unlink,
  } = deps;

  // GET /api/projects/:id/scenes/:sceneId/lower-thirds — get current lower thirds
  app.get('/api/projects/:id/scenes/:sceneId/lower-thirds', async (req, reply) => {
    const { id, sceneId } = req.params as { id: string; sceneId: string };
    const projectPath = await resolveProjectPath(store, id);

    const sb = await loadStoryboard(projectPath);
    if (!sb) return reply.status(404).send({ error: 'No storyboard found', code: 'not_found' });

    const scene = sb.scenes.find((s) => s.id === sceneId);
    if (!scene) return reply.status(404).send({ error: `Scene not found: ${sceneId}`, code: 'scene_not_found' });

    return { sceneId, lowerThirds: scene.lower_thirds ?? [] };
  });

  // POST /api/projects/:id/scenes/:sceneId/lower-thirds/recommend — AI recommend
  // Body: { groundInVideo?: boolean }. Grounded and text-only requests are
  // explicit paths. A grounded failure never falls back to text-only.
  app.post('/api/projects/:id/scenes/:sceneId/lower-thirds/recommend', async (req, reply) => {
    const { id, sceneId } = req.params as { id: string; sceneId: string };
    const parsedBody = RecommendBodySchema.safeParse(req.body ?? {});
    if (!parsedBody.success) {
      return reply.status(400).send({
        error: 'groundInVideo must be a boolean when provided.',
        code: 'invalid_request',
      });
    }
    const body = parsedBody.data;
    const projectPath = await resolveProjectPath(store, id);

    const sb = await loadStoryboard(projectPath);
    if (!sb) return reply.status(404).send({ error: 'No storyboard found', code: 'not_found' });

    const scene = sb.scenes.find((s) => s.id === sceneId);
    if (!scene) return reply.status(404).send({ error: `Scene not found: ${sceneId}`, code: 'scene_not_found' });
    const videoRequested = body.groundInVideo === true;
    if (videoRequested && !scene.recording?.source) {
      return reply.status(400).send({
        error: 'Scene has no recording. Upload a recording first.',
        code: 'no_recording',
      });
    }

    const mode: 'text' | 'video' = videoRequested ? 'video' : 'text';
    let stage: RecommendationStage = 'preparing';
    try {
      const project = await store.readProject(id);
      stage = 'routing';
      const videoModel = mode === 'video' ? await router.resolveVideo(project) : undefined;
      const writer = await router.resolveText('writing', project);
      for (const resolved of [videoModel, writer]) {
        if (resolved) {
          app.log.info(
            modelOperationFields(sceneId, resolved.summary, 'model-resolved'),
            'Lower-third model resolved',
          );
        }
      }

      let briefFreshness: 'generated' | 'reused' | undefined;
      let groundedBriefSource: { path: string; sha256: string } | undefined;
      let recommendations: LowerThird[];
      if (mode === 'video' && videoModel && scene.recording) {
        const briefInput = {
          projectPath: project.path,
          sceneId,
          sceneName: scene.name,
          videoPath: join(project.path, scene.recording.source),
          videoMimeType: 'video/mp4',
        };
        stage = 'video-understanding';
        const briefStatus = await videoUnderstanding.readBriefStatus(briefInput, videoModel);
        briefFreshness = briefStatus.status === 'fresh' ? 'reused' : 'generated';
        const brief = await videoUnderstanding.ensureBrief(briefInput, videoModel, (phase) => {
          app.log.info(
            modelOperationFields(sceneId, videoModel.summary, phase, briefFreshness),
            'Video-grounded lower-third phase',
          );
        });
        groundedBriefSource = {
          path: brief.source.path,
          sha256: brief.source.sha256,
        };
        stage = 'writing';
        app.log.info(
          modelOperationFields(sceneId, writer.summary, 'writing', briefFreshness),
          'Lower-third writing phase',
        );
        recommendations = await recommendLowerThirdsFromBrief({
          videoPath: briefInput.videoPath,
          videoMimeType: briefInput.videoMimeType,
          sceneName: scene.name,
          sceneDescription: scene.description,
          sceneIntent: scene.intent,
          durationSec: scene.recording.duration_sec ?? brief.source.duration_sec,
          projectObjective: project.objective,
          projectAudience: project.audience,
          projectPath: project.path,
          brief,
        }, writer.client, workspaceRoot);
      } else {
        stage = 'writing';
        app.log.info(
          modelOperationFields(sceneId, writer.summary, 'writing'),
          'Lower-third writing phase',
        );
        recommendations = await recommendLowerThirds({
          sceneName: scene.name,
          sceneDescription: scene.description,
          sceneType: scene.type,
          sceneIntent: scene.intent,
          durationSec: scene.recording?.duration_sec,
          projectObjective: project.objective,
          projectAudience: project.audience,
          projectPath: project.path,
        }, writer.client, workspaceRoot);
      }

      // Keep all model output in memory until the complete set validates.
      const lowerThirds = LowerThirdSetSchema.parse(recommendations);

      // Re-read immediately before the single persistence operation so scene
      // edits made during model calls are retained.
      stage = 'persistence';
      const latest = await loadStoryboard(project.path);
      const latestScene = latest?.scenes.find((candidate) => candidate.id === sceneId);
      if (!latest || !latestScene) throw new Error('Scene changed during lower-third recommendation.');
      if (mode === 'video') {
        if (!groundedBriefSource || !latestScene.recording?.source) {
          throw new Error('Recording changed during lower-third recommendation.');
        }
        const latestRecordingPath = join(project.path, latestScene.recording.source);
        const latestFingerprint = await fingerprintRecording(latestRecordingPath);
        if (
          latestRecordingPath !== groundedBriefSource.path
          || latestFingerprint !== groundedBriefSource.sha256
        ) {
          throw new Error('Recording changed during lower-third recommendation.');
        }
      }
      const updated = updateLowerThirds(latest, latestScene, lowerThirds);
      await persistStoryboard(project.path, updated);
      await cleanupLowerThirdArtifacts(project.path, latestScene, removeArtifact);

      return {
        sceneId,
        lowerThirds,
        mode,
        routing: {
          ...(videoModel ? { videoUnderstanding: videoModel.summary } : {}),
          writing: writer.summary,
        },
        ...(briefFreshness ? { briefFreshness } : {}),
      };
    } catch (error) {
      try {
        app.log.error(
          privateRecommendationDiagnostic(error, sceneId, stage),
          'Lower-third recommendation failed',
        );
      } catch {
        // Logging must never change the bounded public failure.
      }
      if (error instanceof ModelRoutingError) {
        return reply.status(error.statusCode).send({
          error: error.message,
          code: error.code,
          role: error.role,
        });
      }
      return reply.status(500).send({
        error: mode === 'video' && stage === 'video-understanding'
          ? VIDEO_LOWER_THIRDS_FAILED_MESSAGE
          : LOWER_THIRDS_FAILED_MESSAGE,
        code: mode === 'video' && stage === 'video-understanding'
          ? 'video_lower_thirds_failed'
          : 'lower_thirds_generation_failed',
      });
    }
  });

  // PUT /api/projects/:id/scenes/:sceneId/lower-thirds — save edited lower thirds
  app.put('/api/projects/:id/scenes/:sceneId/lower-thirds', async (req, reply) => {
    const { id, sceneId } = req.params as { id: string; sceneId: string };
    const { lowerThirds } = req.body as { lowerThirds?: LowerThird[] };

    if (!Array.isArray(lowerThirds)) {
      return reply.status(400).send({ error: 'lowerThirds array is required', code: 'invalid_request' });
    }

    const projectPath = await resolveProjectPath(store, id);

    const sb = await loadStoryboard(projectPath);
    if (!sb) return reply.status(404).send({ error: 'No storyboard found', code: 'not_found' });

    const scene = sb.scenes.find((s) => s.id === sceneId);
    if (!scene) return reply.status(404).send({ error: `Scene not found: ${sceneId}`, code: 'scene_not_found' });

    const updated = updateLowerThirds(sb, scene, lowerThirds);
    await persistStoryboard(projectPath, updated);
    await cleanupLowerThirdArtifacts(projectPath, scene, removeArtifact);

    return { sceneId, lowerThirds };
  });
}
