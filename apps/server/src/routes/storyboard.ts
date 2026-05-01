import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { SceneSchema, type Scene } from '@vpa/shared';
import type { ProjectStore } from '../services/project/store.js';
import {
  loadStoryboard,
  saveStoryboard,
  addScene,
  updateScene,
  removeScene,
  reorderScenes,
} from '../services/storyboard/index.js';

interface Deps {
  store: ProjectStore;
}

async function resolveProjectPath(store: ProjectStore, projectId: string): Promise<string> {
  const tracker = await store.readTracker();
  const entry = tracker.projects.find((p) => p.id === projectId);
  if (!entry) throw { statusCode: 404, message: `Project not found: ${projectId}` };
  return entry.path;
}

export async function registerStoryboardRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { store } = deps;

  // GET /api/projects/:id/storyboard
  app.get('/api/projects/:id/storyboard', async (req, reply) => {
    const { id } = req.params as { id: string };
    const projectPath = await resolveProjectPath(store, id);
    const sb = await loadStoryboard(projectPath);
    if (!sb) return reply.status(404).send({ error: 'No storyboard found', code: 'not_found' });
    return sb;
  });

  // PUT /api/projects/:id/storyboard
  app.put('/api/projects/:id/storyboard', async (req) => {
    const { id } = req.params as { id: string };
    const projectPath = await resolveProjectPath(store, id);
    const storyboard = req.body as import('@vpa/shared').Storyboard;
    await saveStoryboard(projectPath, storyboard);
    return storyboard;
  });

  // POST /api/projects/:id/storyboard/scenes — add a scene
  app.post('/api/projects/:id/storyboard/scenes', async (req, reply) => {
    const { id } = req.params as { id: string };
    const projectPath = await resolveProjectPath(store, id);
    const sb = await loadStoryboard(projectPath);
    if (!sb) return reply.status(404).send({ error: 'No storyboard found', code: 'not_found' });

    const input = req.body as Partial<Scene> & { name: string; description: string };
    const scene: Scene = SceneSchema.parse({
      id: input.id ?? `scene-${randomUUID().slice(0, 8)}`,
      name: input.name,
      description: input.description,
      type: input.type ?? 'desktop',
    });

    const updated = addScene(sb, scene);
    await saveStoryboard(projectPath, updated);
    return updated;
  });

  // PUT /api/projects/:id/storyboard/reorder — reorder scenes
  // NOTE: registered before :sceneId routes to avoid path collision
  app.put('/api/projects/:id/storyboard/reorder', async (req, reply) => {
    const { id } = req.params as { id: string };
    const projectPath = await resolveProjectPath(store, id);
    const sb = await loadStoryboard(projectPath);
    if (!sb) return reply.status(404).send({ error: 'No storyboard found', code: 'not_found' });

    const { orderedIds } = req.body as { orderedIds: string[] };
    if (!Array.isArray(orderedIds)) {
      return reply.status(400).send({ error: 'orderedIds must be an array', code: 'invalid_request' });
    }

    try {
      const updated = reorderScenes(sb, orderedIds);
      await saveStoryboard(projectPath, updated);
      return updated;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ error: msg, code: 'reorder_failed' });
    }
  });

  // PUT /api/projects/:id/storyboard/scenes/:sceneId — update a scene
  app.put('/api/projects/:id/storyboard/scenes/:sceneId', async (req, reply) => {
    const { id, sceneId } = req.params as { id: string; sceneId: string };
    const projectPath = await resolveProjectPath(store, id);
    const sb = await loadStoryboard(projectPath);
    if (!sb) return reply.status(404).send({ error: 'No storyboard found', code: 'not_found' });

    try {
      const updated = updateScene(sb, sceneId, req.body as Partial<Scene>);
      await saveStoryboard(projectPath, updated);
      return updated;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(404).send({ error: msg, code: 'scene_not_found' });
    }
  });

  // DELETE /api/projects/:id/storyboard/scenes/:sceneId — remove a scene
  app.delete('/api/projects/:id/storyboard/scenes/:sceneId', async (req, reply) => {
    const { id, sceneId } = req.params as { id: string; sceneId: string };
    const projectPath = await resolveProjectPath(store, id);
    const sb = await loadStoryboard(projectPath);
    if (!sb) return reply.status(404).send({ error: 'No storyboard found', code: 'not_found' });

    try {
      const updated = removeScene(sb, sceneId);
      await saveStoryboard(projectPath, updated);
      return updated;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(404).send({ error: msg, code: 'scene_not_found' });
    }
  });

}
