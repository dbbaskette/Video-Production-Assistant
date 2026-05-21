import { join } from 'node:path';
import { unlink } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import type { ProjectStore } from '../services/project/store.js';
import type { LlmClient } from '../services/llm/index.js';
import type { ModelRegistry } from '../services/llm/model-registry.js';
import { loadStoryboard, saveStoryboard } from '../services/storyboard/index.js';
import { recommendLowerThirds } from '../services/lower-thirds/index.js';
import { recommendLowerThirdsWithVideo } from '../services/lower-thirds/video-grounded.js';
import type { LowerThird, Scene, Storyboard } from '@vpa/shared';

/**
 * Replace a scene's lower_thirds AND invalidate the caches that depend on
 * them — the baked `overlay_render` video (LTs burned in) and the
 * `frame_render` video downstream of it. Both are kept on disk to speed up
 * subsequent renders; their freshness is checked by existence only, not
 * content, so we have to drop them whenever the LT data is replaced.
 * Without this, the next render reuses the cached overlay and the user
 * sees the LTs they just deleted.
 */
async function updateLowerThirds(
  sb: Storyboard,
  projectPath: string,
  scene: Scene,
  lowerThirds: LowerThird[],
): Promise<Storyboard> {
  if (scene.overlay_render) {
    await unlink(join(projectPath, scene.overlay_render)).catch(() => {});
  }
  if (scene.frame_render) {
    await unlink(join(projectPath, scene.frame_render)).catch(() => {});
  }
  // Build the replacement scene with the cache pointers stripped — we can't
  // pass `undefined` through updateScene because the YAML dump trips on
  // explicit undefined values.
  const { overlay_render: _o, frame_render: _f, ...rest } = scene;
  void _o; void _f;
  const replacement: Scene = { ...rest, lower_thirds: lowerThirds };
  const scenes = sb.scenes.map((s) => (s.id === scene.id ? replacement : s));
  return { ...sb, scenes };
}

interface Deps {
  store: ProjectStore;
  llm: LlmClient;
  workspaceRoot: string;
  /** Used to detect Gemini for video-grounded mode. */
  registry?: ModelRegistry;
}

async function resolveProjectPath(store: ProjectStore, projectId: string): Promise<string> {
  const tracker = await store.readTracker();
  const entry = tracker.projects.find((p) => p.id === projectId);
  if (!entry) throw { statusCode: 404, message: `Project not found: ${projectId}` };
  return entry.path;
}

export async function registerLowerThirdsRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { store, llm, workspaceRoot, registry } = deps;

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
  // Body: { groundInVideo?: boolean }.
  // Video-grounded mode (Gemini-only) uploads the recording to the Files
  // API so the model can anchor each LT timestamp to a real on-screen
  // moment. Falls back to text-only when the active provider isn't Gemini,
  // the registry is unavailable, the scene has no recording, or the flag
  // is false.
  app.post('/api/projects/:id/scenes/:sceneId/lower-thirds/recommend', async (req, reply) => {
    const { id, sceneId } = req.params as { id: string; sceneId: string };
    const body = (req.body ?? {}) as { groundInVideo?: boolean };
    const projectPath = await resolveProjectPath(store, id);

    const sb = await loadStoryboard(projectPath);
    if (!sb) return reply.status(404).send({ error: 'No storyboard found', code: 'not_found' });

    const scene = sb.scenes.find((s) => s.id === sceneId);
    if (!scene) return reply.status(404).send({ error: `Scene not found: ${sceneId}`, code: 'scene_not_found' });

    // Pull objective + audience from project.yaml so they reach the
    // prompt — same pattern the script + analyze routes use.
    let projectObjective: string | undefined;
    let projectAudience: string | undefined;
    try {
      const project = await store.readProject(id);
      projectObjective = project.objective;
      projectAudience = project.audience;
    } catch {
      // project.yaml missing shouldn't block LT recommendation.
    }

    const active = registry?.getActive();
    const canUseVideo =
      body.groundInVideo === true &&
      active?.provider === 'gemini' &&
      !!active.apiKey &&
      !!scene.recording?.source;

    let lowerThirds: LowerThird[];
    let mode: 'text' | 'video' = 'text';
    try {
      if (canUseVideo && active && scene.recording) {
        mode = 'video';
        lowerThirds = await recommendLowerThirdsWithVideo(
          {
            videoPath: join(projectPath, scene.recording.source),
            videoMimeType: 'video/mp4',
            sceneName: scene.name,
            sceneDescription: scene.description,
            sceneIntent: scene.intent,
            durationSec: scene.recording.duration_sec,
            projectObjective,
            projectAudience,
            projectPath,
          },
          { apiKey: active.apiKey!, model: active.model },
          workspaceRoot,
          llm,
          (phase, detail) => {
            app.log.info({ sceneId, phase, detail }, 'video-grounded LT phase');
          },
        );
      } else {
        lowerThirds = await recommendLowerThirds(
          {
            sceneName: scene.name,
            sceneDescription: scene.description,
            sceneType: scene.type,
            sceneIntent: scene.intent,
            durationSec: scene.recording?.duration_sec,
            projectObjective,
            projectAudience,
            projectPath,
          },
          llm,
          workspaceRoot,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      app.log.error({ err: msg }, 'lower-thirds recommendation failed');
      return reply.status(500).send({
        error: `Lower-thirds recommendation failed: ${msg}`,
        code: 'lt_recommend_failed',
      });
    }

    const updated = await updateLowerThirds(sb, projectPath, scene, lowerThirds);
    await saveStoryboard(projectPath, updated);

    return { sceneId, lowerThirds, mode };
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

    const updated = await updateLowerThirds(sb, projectPath, scene, lowerThirds);
    await saveStoryboard(projectPath, updated);

    return { sceneId, lowerThirds };
  });
}
