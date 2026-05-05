import type { FastifyInstance } from 'fastify';
import type { ProjectStore } from '../services/project/store.js';
import type { LlmClient } from '../services/llm/index.js';
import { loadStoryboard, saveStoryboard, updateScene } from '../services/storyboard/index.js';
import { recommendLowerThirds } from '../services/lower-thirds/index.js';
import type { LowerThird } from '@vpa/shared';

interface Deps {
  store: ProjectStore;
  llm: LlmClient;
  workspaceRoot: string;
}

async function resolveProjectPath(store: ProjectStore, projectId: string): Promise<string> {
  const tracker = await store.readTracker();
  const entry = tracker.projects.find((p) => p.id === projectId);
  if (!entry) throw { statusCode: 404, message: `Project not found: ${projectId}` };
  return entry.path;
}

export async function registerLowerThirdsRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { store, llm, workspaceRoot } = deps;

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
  app.post('/api/projects/:id/scenes/:sceneId/lower-thirds/recommend', async (req, reply) => {
    const { id, sceneId } = req.params as { id: string; sceneId: string };
    const projectPath = await resolveProjectPath(store, id);

    const sb = await loadStoryboard(projectPath);
    if (!sb) return reply.status(404).send({ error: 'No storyboard found', code: 'not_found' });

    const scene = sb.scenes.find((s) => s.id === sceneId);
    if (!scene) return reply.status(404).send({ error: `Scene not found: ${sceneId}`, code: 'scene_not_found' });

    const lowerThirds = await recommendLowerThirds(
      {
        sceneName: scene.name,
        sceneDescription: scene.description,
        sceneType: scene.type,
        durationSec: scene.recording?.duration_sec,
        projectPath,
      },
      llm,
      workspaceRoot,
    );

    // Save to storyboard
    const updated = updateScene(sb, sceneId, { lower_thirds: lowerThirds });
    await saveStoryboard(projectPath, updated);

    return { sceneId, lowerThirds };
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

    const updated = updateScene(sb, sceneId, { lower_thirds: lowerThirds });
    await saveStoryboard(projectPath, updated);

    return { sceneId, lowerThirds };
  });
}
