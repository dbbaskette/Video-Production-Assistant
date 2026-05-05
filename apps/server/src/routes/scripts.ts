import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { ProjectStore } from '../services/project/store.js';
import type { LlmClient } from '../services/llm/index.js';
import type { ModelRegistry } from '../services/llm/model-registry.js';
import { loadStoryboard, saveStoryboard, updateScene } from '../services/storyboard/index.js';
import { generateScript } from '../services/script/index.js';
import { convertToDialog } from '../services/script/convert-to-dialog.js';
import { generateVideoGroundedScript } from '../services/video-narration/index.js';

interface Deps {
  store: ProjectStore;
  llm: LlmClient;
  workspaceRoot: string;
  /** Used to detect the active provider + grab its API key for video-grounded mode. */
  registry: ModelRegistry;
}

async function resolveProjectPath(store: ProjectStore, projectId: string): Promise<string> {
  const tracker = await store.readTracker();
  const entry = tracker.projects.find((p) => p.id === projectId);
  if (!entry) throw { statusCode: 404, message: `Project not found: ${projectId}` };
  return entry.path;
}

export async function registerScriptRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { store, llm, workspaceRoot, registry } = deps;

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

    // Decide which path to take. Video-grounded only kicks in when the user
    // explicitly asked for it AND the active provider is Gemini AND the scene
    // has a recording. Otherwise fall back to text-only — non-Gemini callers
    // should never crash here.
    const active = registry.getActive();
    const canUseVideo =
      body.groundInVideo === true &&
      active?.provider === 'gemini' &&
      !!active.apiKey &&
      !!scene.recording?.source;

    let script: string;
    let mode: 'text' | 'video' = 'text';
    if (canUseVideo && active && scene.recording) {
      mode = 'video';
      const videoPath = join(projectPath, scene.recording.source);
      try {
        script = await generateVideoGroundedScript(
          {
            videoPath,
            videoMimeType: 'video/mp4',
            sceneName: scene.name,
            sceneDescription: scene.description,
            durationSec: scene.recording.duration_sec ?? 30,
            projectObjective: sb.project.objective,
            projectAudience: sb.project.audience,
            projectPath,
          },
          { apiKey: active.apiKey!, model: active.model },
          workspaceRoot,
          llm,
          (phase, detail) => {
            app.log.info({ sceneId, phase, detail }, 'video-grounded script phase');
          },
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        app.log.error({ err: msg }, 'video-grounded script generation failed');
        return reply.status(500).send({
          error: `Video-grounded generation failed: ${msg}`,
          code: 'video_script_failed',
        });
      }
    } else {
      script = await generateScript(
        {
          sceneName: scene.name,
          sceneDescription: scene.description,
          sceneType: scene.type,
          durationSec: scene.recording?.duration_sec,
          projectObjective: sb.project.objective,
          projectAudience: sb.project.audience,
          projectPath,
        },
        llm,
        workspaceRoot,
      );
    }

    // Phase 1: persist the monologue right now. If the user navigates away
    // while the dialog half is still running, refreshing storyboard.yaml
    // will at least show the monologue rather than the previous (or empty)
    // state. Mode stays at whatever the scene already had.
    {
      const narration = { ...(scene.narration ?? {}), script, monologueScript: script };
      const updated = updateScene(sb, sceneId, { narration: narration as any });
      await saveStoryboard(projectPath, updated);
    }

    // Phase 2: auto-generate the dialog variant alongside so flipping modes
    // is instant. Best-effort — failures are logged; the primary flow
    // (monologue saved above) is never blocked.
    let dialogScript: string | undefined;
    try {
      const result = await convertToDialog(script, llm, workspaceRoot, projectPath);
      dialogScript = result.dialogScript;
    } catch (err) {
      app.log.warn(
        `Auto dialog-conversion failed for ${sceneId}; monologue is saved. Reason: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    // Phase 2 save — re-load the storyboard so we don't clobber any other
    // changes that might have landed during the LLM call. (E.g. user
    // edited a different scene in another tab while we were waiting.)
    if (dialogScript) {
      const sb2 = await loadStoryboard(projectPath);
      if (sb2) {
        const scene2 = sb2.scenes.find((s) => s.id === sceneId);
        if (scene2) {
          const narration = {
            ...(scene2.narration ?? {}),
            script,
            monologueScript: script,
            dialogScript,
          };
          const updated = updateScene(sb2, sceneId, { narration: narration as any });
          await saveStoryboard(projectPath, updated);
        }
      }
    }

    return { sceneId, script, dialogScript, mode };
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

    const narration = { ...(scene.narration ?? {}), script, monologueScript: script };
    const updated = updateScene(sb, sceneId, { narration: narration as any });
    await saveStoryboard(projectPath, updated);

    return { sceneId, script };
  });
}
