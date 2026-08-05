import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ProjectStore } from '../services/project/store.js';
import { ModelRouter, ModelRoutingError } from '../services/llm/model-router.js';
import { loadStoryboard, saveStoryboard, mutateStoryboard, updateScene } from '../services/storyboard/index.js';
import { generateScript } from '../services/script/index.js';
import { convertToDialog } from '../services/script/convert-to-dialog.js';
import { generateScriptFromVideoBrief } from '../services/script/video-grounded.js';
import { tightenScript } from '../services/script/tighten.js';
import { polishScript } from '../services/script/polish.js';
import { computeProjectWpm } from '../services/script/wpm.js';
import { VideoUnderstandingService } from '../services/video-understanding/index.js';
import {
  loadProjectSourceContext,
  sourceDocsNeedSummarization,
} from '../services/project-source-docs/context.js';
import type { ResolvedModelSummary } from '@vpa/shared';
import type { AgentRecordingCoordinator } from '../services/agent-recording/coordinator.js';
import { sha256File } from '../services/recording/metadata.js';
import { loadSceneAtRecordingVersion } from '../services/recording/version.js';
import { safeSceneDiagnosticFields } from '../lib/safe-diagnostics.js';

const GenerateBodySchema = z.object({
  groundInVideo: z.boolean().optional(),
}).strict();

interface Deps {
  store: ProjectStore;
  workspaceRoot: string;
  router: ModelRouter;
  videoUnderstanding: VideoUnderstandingService;
  agentRecordingCoordinator: Pick<AgentRecordingCoordinator, 'withManualUploadReservation'>;
  fingerprintRecording?: (filePath: string) => Promise<string>;
}

type GenerationStage =
  | 'preparing'
  | 'routing'
  | 'video-understanding'
  | 'source-summarization'
  | 'writing'
  | 'dialog'
  | 'persistence';

class UserMutationError extends Error {
  constructor(readonly code: 'not_found' | 'scene_not_found', message: string) {
    super(message);
  }
}

const VIDEO_SCRIPT_FAILED_MESSAGE =
  'Video-grounded script generation failed. Your existing script was not changed.';
const SCRIPT_FAILED_MESSAGE =
  'Script generation failed. Your existing script was not changed.';

function privateGenerationDiagnostic(
  error: unknown,
  sceneId: string,
  stage: GenerationStage,
): Record<string, unknown> {
  if (error instanceof ModelRoutingError) {
    return {
      ...safeSceneDiagnosticFields(sceneId),
      stage,
      errorName: 'ModelRoutingError',
      code: error.code,
      role: error.role,
      scope: error.scope,
    };
  }
  return { ...safeSceneDiagnosticFields(sceneId), stage, errorName: 'GenerationError' };
}

function assertGeneratedScript(value: string, kind: 'script' | 'dialog'): void {
  if (!value.trim()) throw new Error(`The writing model returned an empty ${kind}.`);
  if (kind === 'dialog' && !/^\[Speaker\s+[AB]\]/im.test(value)) {
    throw new Error('The writing model returned an invalid dialog.');
  }
}

function modelOperationFields(
  sceneId: string,
  summary: ResolvedModelSummary,
  phase: string,
  briefFreshness?: 'generated' | 'reused',
): Record<string, unknown> {
  return {
    ...safeSceneDiagnosticFields(sceneId),
    operation: 'script-generation',
    phase,
    role: summary.role,
    entryId: summary.entry_id,
    provider: summary.provider,
    model: summary.model,
    ...(briefFreshness ? { briefFreshness } : {}),
  };
}

async function resolveProjectPath(store: ProjectStore, projectId: string): Promise<string> {
  const tracker = await store.readTracker();
  const entry = tracker.projects.find((p) => p.id === projectId);
  if (!entry) throw { statusCode: 404, message: `Project not found: ${projectId}` };
  return entry.path;
}

async function resolveProject(store: ProjectStore, projectId: string) {
  try {
    return await store.readProject(projectId);
  } catch {
    throw { statusCode: 404, message: `Project not found: ${projectId}` };
  }
}

export async function registerScriptRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const {
    store,
    workspaceRoot,
    router,
    videoUnderstanding,
    agentRecordingCoordinator,
    fingerprintRecording = sha256File,
  } = deps;

  // GET /api/projects/:id/scenes/:sceneId/script — get current script
  app.get('/api/projects/:id/scenes/:sceneId/script', async (req, reply) => {
    const { id, sceneId } = req.params as { id: string; sceneId: string };
    const projectPath = await resolveProjectPath(store, id);

    const sb = await loadStoryboard(projectPath);
    if (!sb) return reply.status(404).send({ error: 'No storyboard found', code: 'not_found' });

    const scene = sb.scenes.find((s) => s.id === sceneId);
    if (!scene) return reply.status(404).send({ error: `Scene not found: ${sceneId}`, code: 'scene_not_found' });

    return {
      sceneId,
      script: scene.narration?.script ?? null,
      hasRecording: !!scene.recording,
    };
  });

  // POST /api/projects/:id/scenes/:sceneId/script/generate — generate script via LLM.
  // Two modes:
  //   • text-only (default): scene metadata + source-docs → narration script
  //   • video-grounded (groundInVideo: true, requires Gemini + a recording):
  //       uploads the recording to Gemini Files API and asks the model to write
  //       a script grounded in what's actually on screen
  app.post('/api/projects/:id/scenes/:sceneId/script/generate', async (req, reply) => {
    const { id, sceneId } = req.params as { id: string; sceneId: string };
    const parsedBody = GenerateBodySchema.safeParse(req.body === undefined ? {} : req.body);
    if (!parsedBody.success) {
      return reply.status(400).send({
        error: 'groundInVideo must be a boolean when provided.',
        code: 'invalid_request',
      });
    }
    const body = parsedBody.data;
    const project = await resolveProject(store, id);
    const projectPath = project.path;

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
    const operationState: { stage: GenerationStage } = { stage: 'preparing' };
    try {
      const needsGeneral = await sourceDocsNeedSummarization(project.path);

      operationState.stage = 'routing';
      const videoModel = mode === 'video' ? await router.resolveVideo(project) : undefined;
      const writer = await router.resolveText('writing', project);
      const general = needsGeneral
        ? await router.resolveText('general', project)
        : undefined;
      for (const resolved of [videoModel, writer, general]) {
        if (resolved) {
          app.log.info(
            modelOperationFields(sceneId, resolved.summary, 'model-resolved'),
            'Script model resolved',
          );
        }
      }

      const generateAndPersist = async () => {
        let operationScene = scene;
        if (mode === 'video') {
          const current = await loadStoryboard(project.path);
          const currentScene = current?.scenes.find((candidate) => candidate.id === sceneId);
          if (!currentScene?.recording?.source) {
            throw new Error('Scene recording changed before script generation.');
          }
          operationScene = currentScene;
        }

        let briefFreshness: 'generated' | 'reused' | undefined;
        let groundedBriefSource: { path: string; sha256: string } | undefined;
        let script: string;
        if (mode === 'video' && videoModel && operationScene.recording) {
          const briefInput = {
            projectPath: project.path,
            sceneId,
            sceneName: operationScene.name,
            videoPath: join(project.path, operationScene.recording.source),
            videoMimeType: 'video/mp4',
          };
          operationState.stage = 'video-understanding';
          const briefStatus = await videoUnderstanding.readBriefStatus(briefInput, videoModel);
          briefFreshness = briefStatus.status === 'fresh' ? 'reused' : 'generated';
          const brief = await videoUnderstanding.ensureBrief(briefInput, videoModel, (phase) => {
            app.log.info(
              modelOperationFields(sceneId, videoModel.summary, phase, briefFreshness),
              'Video-grounded script phase',
            );
          });
          groundedBriefSource = { path: brief.source.path, sha256: brief.source.sha256 };

          operationState.stage = needsGeneral ? 'source-summarization' : 'writing';
          if (general) {
            app.log.info(
              modelOperationFields(sceneId, general.summary, 'source-summarization'),
              'Script source summarization phase',
            );
          }
          const sourceContext = await loadProjectSourceContext(project.path, general?.client);
          operationState.stage = 'writing';
          app.log.info(
            modelOperationFields(sceneId, writer.summary, 'writing', briefFreshness),
            'Script writing phase',
          );
          script = await generateScriptFromVideoBrief({
            sceneName: operationScene.name,
            sceneDescription: operationScene.description,
            sceneIntent: operationScene.intent,
            durationSec: operationScene.recording.duration_sec ?? brief.source.duration_sec,
            projectObjective: project.objective,
            projectAudience: project.audience,
            sourceContext,
            brief,
          }, writer.client, workspaceRoot);
        } else {
          operationState.stage = needsGeneral ? 'source-summarization' : 'writing';
          if (general) {
            app.log.info(
              modelOperationFields(sceneId, general.summary, 'source-summarization'),
              'Script source summarization phase',
            );
          }
          const sourceContext = await loadProjectSourceContext(project.path, general?.client);
          operationState.stage = 'writing';
          app.log.info(
            modelOperationFields(sceneId, writer.summary, 'writing'),
            'Script writing phase',
          );
          script = await generateScript({
            sceneName: operationScene.name,
            sceneDescription: operationScene.description,
            sceneIntent: operationScene.intent,
            sceneType: operationScene.type,
            durationSec: operationScene.recording?.duration_sec,
            projectObjective: project.objective,
            projectAudience: project.audience,
            sourceContext,
          }, writer.client, workspaceRoot);
        }
        assertGeneratedScript(script, 'script');

        operationState.stage = 'dialog';
        app.log.info(
          modelOperationFields(sceneId, writer.summary, 'dialog', briefFreshness),
          'Script dialog phase',
        );
        const dialog = await convertToDialog(script, writer.client, workspaceRoot);
        assertGeneratedScript(dialog.dialogScript, 'dialog');

        // All generated values remain in memory until both variants validate.
        // Re-read once before the single persistence operation so unrelated scene
        // edits made during model calls are retained.
        operationState.stage = 'persistence';
        const latestVersion = mode === 'video' && groundedBriefSource
          ? await loadSceneAtRecordingVersion(
              project.path,
              sceneId,
              groundedBriefSource,
              fingerprintRecording,
            )
          : undefined;
        const latest = latestVersion?.storyboard ?? await loadStoryboard(project.path);
        const latestScene = latestVersion?.scene
          ?? latest?.scenes.find((candidate) => candidate.id === sceneId);
        if (!latest || !latestScene) throw new Error('Scene changed during script generation.');
        const narration = {
          ...(latestScene.narration ?? {}),
          script,
          monologueScript: script,
          dialogScript: dialog.dialogScript,
          chunks: undefined,
          audio: undefined,
          subtitles: undefined,
          timings: undefined,
        };
        await saveStoryboard(
          project.path,
          updateScene(latest, sceneId, { narration }),
        );

        return {
          sceneId,
          mode,
          routing: {
            ...(videoModel ? { videoUnderstanding: videoModel.summary } : {}),
            writing: writer.summary,
            ...(general ? { general: general.summary } : {}),
          },
          ...(briefFreshness ? { briefFreshness } : {}),
          script,
          dialog: dialog.dialogScript,
          // Compatibility for the current web client while it migrates to `dialog`.
          dialogScript: dialog.dialogScript,
        };
      };

      return mode === 'video'
        ? await agentRecordingCoordinator.withManualUploadReservation(
            id,
            [sceneId],
            generateAndPersist,
          )
        : await generateAndPersist();
    } catch (error) {
      try {
        app.log.error(
          privateGenerationDiagnostic(error, sceneId, operationState.stage),
          'Script generation failed',
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
        error: mode === 'video' && operationState.stage === 'video-understanding'
          ? VIDEO_SCRIPT_FAILED_MESSAGE
          : SCRIPT_FAILED_MESSAGE,
        code: mode === 'video' && operationState.stage === 'video-understanding'
          ? 'video_script_failed'
          : 'script_generation_failed',
      });
    }
  });

  // PUT /api/projects/:id/scenes/:sceneId/intent — save the user-authored
  // "what is this scene supposed to demonstrate" string. Persisted on the
  // scene; the script generator uses it as the north star, with the video
  // as visual/pacing anchor and source-docs as the factual reference.
  // Empty string clears it. Never touched by Re-analyze.
  app.put('/api/projects/:id/scenes/:sceneId/intent', async (req, reply) => {
    const { id, sceneId } = req.params as { id: string; sceneId: string };
    const body = (req.body ?? {}) as { intent?: string };
    if (typeof body.intent !== 'string') {
      return reply.status(400).send({ error: 'intent must be a string', code: 'invalid_request' });
    }
    const projectPath = await resolveProjectPath(store, id);
    const trimmed = body.intent.trim();
    try {
      await mutateStoryboard(projectPath, (current) => {
        if (!current) throw new UserMutationError('not_found', 'No storyboard found');
        if (!current.scenes.some((scene) => scene.id === sceneId)) {
          throw new UserMutationError('scene_not_found', `Scene not found: ${sceneId}`);
        }
        return updateScene(current, sceneId, { intent: trimmed.length > 0 ? trimmed : undefined });
      });
    } catch (error) {
      if (!(error instanceof UserMutationError)) throw error;
      return reply.status(404).send({ error: error.message, code: error.code });
    }
    return { sceneId, intent: trimmed.length > 0 ? trimmed : null };
  });

  // PUT /api/projects/:id/scenes/:sceneId/script — save edited script
  app.put('/api/projects/:id/scenes/:sceneId/script', async (req, reply) => {
    const { id, sceneId } = req.params as { id: string; sceneId: string };
    const { script } = req.body as { script?: string };

    if (typeof script !== 'string') {
      return reply.status(400).send({ error: 'script is required', code: 'invalid_request' });
    }

    const projectPath = await resolveProjectPath(store, id);

    try {
      await mutateStoryboard(projectPath, (current) => {
        if (!current) throw new UserMutationError('not_found', 'No storyboard found');
        const scene = current.scenes.find((candidate) => candidate.id === sceneId);
        if (!scene) throw new UserMutationError('scene_not_found', `Scene not found: ${sceneId}`);
        const narration = {
          ...(scene.narration ?? {}),
          script,
          monologueScript: script,
          chunks: undefined,
          audio: undefined,
          subtitles: undefined,
          timings: undefined,
        };
        return updateScene(current, sceneId, { narration });
      });
    } catch (error) {
      if (!(error instanceof UserMutationError)) throw error;
      return reply.status(404).send({ error: error.message, code: error.code });
    }

    return { sceneId, script };
  });

  // POST /api/projects/:id/scenes/:sceneId/script/tighten — propose a shorter
  // script that fits the recording duration. Returns the proposal WITHOUT
  // saving; the client decides whether to accept and PUT it back.
  // Used by the Quality Review page when a "narration too long for the clip"
  // warning lands — the actionable fix is to tighten the script, not to
  // tweak TTS speed on the Narration tab.
  app.post('/api/projects/:id/scenes/:sceneId/script/tighten', async (req, reply) => {
    const { id, sceneId } = req.params as { id: string; sceneId: string };
    const body = (req.body ?? {}) as { targetDurationSec?: number };
    const project = await resolveProject(store, id);
    const projectPath = project.path;

    const sb = await loadStoryboard(projectPath);
    if (!sb) return reply.status(404).send({ error: 'No storyboard found', code: 'not_found' });

    const scene = sb.scenes.find((s) => s.id === sceneId);
    if (!scene) return reply.status(404).send({ error: `Scene not found: ${sceneId}`, code: 'scene_not_found' });

    const currentScript =
      scene.narration?.script ?? scene.narration?.monologueScript ?? '';
    if (!currentScript.trim()) {
      return reply.status(400).send({
        error: 'Scene has no script to tighten',
        code: 'no_script',
      });
    }

    const targetDurationSec =
      typeof body.targetDurationSec === 'number' && body.targetDurationSec > 0
        ? body.targetDurationSec
        : scene.recording?.duration_sec;
    if (!targetDurationSec || targetDurationSec <= 0) {
      return reply.status(400).send({
        error: 'No target duration available — upload a recording or pass targetDurationSec',
        code: 'no_duration',
      });
    }

    // Empirical wpm from this project's already-generated chunks. Falls
    // back to 150 wpm when no narration has been generated yet. Same
    // source of truth Quality Review uses, so the two never disagree on
    // whether a script is "too long".
    const wpmInfo = computeProjectWpm(sb);

    try {
      const writer = await router.resolveText('writing', project);
      const result = await tightenScript(
        {
          currentScript,
          targetDurationSec,
          sceneName: scene.name,
          sceneIntent: scene.intent,
          wpm: wpmInfo.wpm,
        },
        writer.client,
        workspaceRoot,
      );
      return {
        sceneId,
        currentScript,
        proposedScript: result.proposedScript,
        currentWords: result.currentWords,
        targetWords: result.targetWords,
        proposedWords: result.proposedWords,
        targetDurationSec,
        reason: result.reason,
        wpm: wpmInfo.wpm,
        wpmIsMeasured: wpmInfo.isMeasured,
        wpmSampleChunks: wpmInfo.sampleChunks,
      };
    } catch (error) {
      if (error instanceof ModelRoutingError) {
        return reply.status(error.statusCode).send({
          error: error.message,
          code: error.code,
          role: error.role,
        });
      }
      app.log.error(
        { ...safeSceneDiagnosticFields(sceneId), errorName: 'TightenError' },
        'Script tighten failed',
      );
      return reply.status(500).send({
        error: 'Script tighten failed. Your existing script was not changed.',
        code: 'tighten_failed',
      });
    }
  });

  // POST /api/projects/:id/scenes/:sceneId/script/polish — evaluate + editorially
  // polish a USER-SUPPLIED draft: improve pacing/clarity/flow, add emotive tags,
  // and fit it to the recording length. Returns the proposal WITHOUT saving —
  // the client shows it in a side-by-side review modal and PUTs it back on accept.
  // This is the "bring your own script" counterpart to /generate (which writes
  // from scratch) and /tighten (which only removes content).
  app.post('/api/projects/:id/scenes/:sceneId/script/polish', async (req, reply) => {
    const { id, sceneId } = req.params as { id: string; sceneId: string };
    const body = (req.body ?? {}) as { draft?: string; targetDurationSec?: number };

    // Validate the draft up front — an empty paste is the one thing polish
    // can't act on, and the client disables the button for it anyway.
    const draft = typeof body.draft === 'string' ? body.draft : '';
    if (!draft.trim()) {
      return reply.status(400).send({ error: 'draft is required', code: 'no_draft' });
    }

    const project = await resolveProject(store, id);
    const projectPath = project.path;
    const sb = await loadStoryboard(projectPath);
    if (!sb) return reply.status(404).send({ error: 'No storyboard found', code: 'not_found' });

    const scene = sb.scenes.find((s) => s.id === sceneId);
    if (!scene) return reply.status(404).send({ error: `Scene not found: ${sceneId}`, code: 'scene_not_found' });

    // Fit target: explicit override, else the recording's duration. Undefined
    // when the scene has no recording — polish then improves quality only and
    // the client tells the user it wasn't fitted to length.
    const targetDurationSec =
      typeof body.targetDurationSec === 'number' && body.targetDurationSec > 0
        ? body.targetDurationSec
        : scene.recording?.duration_sec;

    // Same measured-wpm source of truth Generate + Tighten + Quality Review use.
    const wpmInfo = computeProjectWpm(sb);

    try {
      const needsGeneral = await sourceDocsNeedSummarization(project.path);
      const writer = await router.resolveText('writing', project);
      const general = needsGeneral
        ? await router.resolveText('general', project)
        : undefined;
      const result = await polishScript(
        {
          draft,
          targetDurationSec,
          wpm: wpmInfo.wpm,
          sceneName: scene.name,
          sceneIntent: scene.intent,
          projectObjective: sb.project.objective,
          projectAudience: sb.project.audience,
          projectPath,
        },
        writer.client,
        workspaceRoot,
        general?.client,
      );
      return {
        sceneId,
        originalScript: draft,
        proposedScript: result.proposedScript,
        notes: result.notes,
        currentWords: result.currentWords,
        proposedWords: result.proposedWords,
        targetWords: result.targetWords ?? null,
        targetDurationSec: targetDurationSec ?? null,
        wpm: wpmInfo.wpm,
        wpmIsMeasured: wpmInfo.isMeasured,
        wpmSampleChunks: wpmInfo.sampleChunks,
      };
    } catch (error) {
      if (error instanceof ModelRoutingError) {
        return reply.status(error.statusCode).send({
          error: error.message,
          code: error.code,
          role: error.role,
        });
      }
      app.log.error(
        { ...safeSceneDiagnosticFields(sceneId), errorName: 'PolishError' },
        'Script polish failed',
      );
      return reply.status(500).send({
        error: 'Script polish failed. Your existing script was not changed.',
        code: 'polish_failed',
      });
    }
  });
}
