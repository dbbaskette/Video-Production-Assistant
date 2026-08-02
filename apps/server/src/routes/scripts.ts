import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { ProjectStore } from '../services/project/store.js';
import type { LlmClient } from '../services/llm/index.js';
import { ModelRouter, ModelRoutingError } from '../services/llm/model-router.js';
import { loadStoryboard, saveStoryboard, updateScene } from '../services/storyboard/index.js';
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

interface Deps {
  store: ProjectStore;
  llm: LlmClient;
  workspaceRoot: string;
  router: ModelRouter;
  videoUnderstanding: VideoUnderstandingService;
}

type GenerationStage =
  | 'preparing'
  | 'routing'
  | 'video-understanding'
  | 'source-summarization'
  | 'writing'
  | 'dialog'
  | 'persistence';

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
      sceneId,
      stage,
      errorName: 'ModelRoutingError',
      code: error.code,
      role: error.role,
      scope: error.scope,
    };
  }
  return { sceneId, stage, errorName: 'GenerationError' };
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
    sceneId,
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

export async function registerScriptRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { store, llm, workspaceRoot, router, videoUnderstanding } = deps;

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
    const body = (req.body ?? {}) as { groundInVideo?: boolean };
    const projectPath = await resolveProjectPath(store, id);

    const sb = await loadStoryboard(projectPath);
    if (!sb) return reply.status(404).send({ error: 'No storyboard found', code: 'not_found' });

    const scene = sb.scenes.find((s) => s.id === sceneId);
    if (!scene) return reply.status(404).send({ error: `Scene not found: ${sceneId}`, code: 'scene_not_found' });

    const mode: 'text' | 'video' =
      body.groundInVideo === true && !!scene.recording?.source ? 'video' : 'text';
    let stage: GenerationStage = 'preparing';
    try {
      const project = await store.readProject(id);
      const needsGeneral = await sourceDocsNeedSummarization(project.path);

      stage = 'routing';
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

      let briefFreshness: 'generated' | 'reused' | undefined;
      let script: string;
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
            'Video-grounded script phase',
          );
        });

        stage = needsGeneral ? 'source-summarization' : 'writing';
        if (general) {
          app.log.info(
            modelOperationFields(sceneId, general.summary, 'source-summarization'),
            'Script source summarization phase',
          );
        }
        const sourceContext = await loadProjectSourceContext(project.path, general?.client);
        stage = 'writing';
        app.log.info(
          modelOperationFields(sceneId, writer.summary, 'writing', briefFreshness),
          'Script writing phase',
        );
        script = await generateScriptFromVideoBrief({
          sceneName: scene.name,
          sceneDescription: scene.description,
          sceneIntent: scene.intent,
          durationSec: scene.recording.duration_sec ?? brief.source.duration_sec,
          projectObjective: project.objective,
          projectAudience: project.audience,
          sourceContext,
          brief,
        }, writer.client, workspaceRoot);
      } else {
        stage = needsGeneral ? 'source-summarization' : 'writing';
        if (general) {
          app.log.info(
            modelOperationFields(sceneId, general.summary, 'source-summarization'),
            'Script source summarization phase',
          );
        }
        const sourceContext = await loadProjectSourceContext(project.path, general?.client);
        stage = 'writing';
        app.log.info(
          modelOperationFields(sceneId, writer.summary, 'writing'),
          'Script writing phase',
        );
        script = await generateScript({
          sceneName: scene.name,
          sceneDescription: scene.description,
          sceneIntent: scene.intent,
          sceneType: scene.type,
          durationSec: scene.recording?.duration_sec,
          projectObjective: project.objective,
          projectAudience: project.audience,
          sourceContext,
        }, writer.client, workspaceRoot);
      }
      assertGeneratedScript(script, 'script');

      stage = 'dialog';
      app.log.info(
        modelOperationFields(sceneId, writer.summary, 'dialog', briefFreshness),
        'Script dialog phase',
      );
      const dialog = await convertToDialog(script, writer.client, workspaceRoot);
      assertGeneratedScript(dialog.dialogScript, 'dialog');

      // All generated values remain in memory until both variants validate.
      // Re-read once before the single persistence operation so unrelated scene
      // edits made during model calls are retained.
      stage = 'persistence';
      const latest = await loadStoryboard(project.path);
      const latestScene = latest?.scenes.find((candidate) => candidate.id === sceneId);
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
    } catch (error) {
      try {
        app.log.error(
          privateGenerationDiagnostic(error, sceneId, stage),
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
        error: mode === 'video' && stage === 'video-understanding'
          ? VIDEO_SCRIPT_FAILED_MESSAGE
          : SCRIPT_FAILED_MESSAGE,
        code: mode === 'video' && stage === 'video-understanding'
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
    const sb = await loadStoryboard(projectPath);
    if (!sb) return reply.status(404).send({ error: 'No storyboard found', code: 'not_found' });
    const scene = sb.scenes.find((s) => s.id === sceneId);
    if (!scene) return reply.status(404).send({ error: `Scene not found: ${sceneId}`, code: 'scene_not_found' });

    // Trim and treat empty as "cleared".
    const trimmed = body.intent.trim();
    const updated = updateScene(sb, sceneId, { intent: trimmed.length > 0 ? trimmed : undefined });
    await saveStoryboard(projectPath, updated);
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

    const sb = await loadStoryboard(projectPath);
    if (!sb) return reply.status(404).send({ error: 'No storyboard found', code: 'not_found' });

    const scene = sb.scenes.find((s) => s.id === sceneId);
    if (!scene) return reply.status(404).send({ error: `Scene not found: ${sceneId}`, code: 'scene_not_found' });

    // Wipe TTS-derived artefacts: any rendered audio chunks pointed at the
    // PREVIOUS script's paragraphs, so re-using them would play the wrong
    // narration over the new wording. Same rationale (and same field list)
    // as POST /script/generate. The user has to regenerate TTS on the
    // Narration tab — Generate All becomes a one-click recovery.
    const narration = {
      ...(scene.narration ?? {}),
      script,
      monologueScript: script,
      chunks: undefined,
      audio: undefined,
      subtitles: undefined,
      timings: undefined,
    };
    const updated = updateScene(sb, sceneId, { narration });
    await saveStoryboard(projectPath, updated);

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
    const projectPath = await resolveProjectPath(store, id);

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
      const result = await tightenScript(
        {
          currentScript,
          targetDurationSec,
          sceneName: scene.name,
          sceneIntent: scene.intent,
          wpm: wpmInfo.wpm,
        },
        llm,
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
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      app.log.error({ err: msg, sceneId }, 'script tighten failed');
      return reply.status(500).send({
        error: `Script tighten failed: ${msg}`,
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

    const projectPath = await resolveProjectPath(store, id);
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
        llm,
        workspaceRoot,
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
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      app.log.error({ err: msg, sceneId }, 'script polish failed');
      return reply.status(500).send({
        error: `Script polish failed: ${msg}`,
        code: 'polish_failed',
      });
    }
  });
}
