import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { z } from 'zod';
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
import {
  loadFrameManifest,
  defaultAssetsDir,
  getFrame,
} from '../services/frame/manifest.js';
import { join } from 'node:path';

interface Deps {
  store: ProjectStore;
  /** Optional override for the device-frames assets directory (used in tests). */
  assetsDir?: string;
}

const FrameSettingsSchema = z.object({
  frame_style: z.string().nullable().optional(),
  frame_background: z
    .union([
      z.literal('brand'),
      z.literal('transparent'),
      z.string().regex(/^#[0-9a-fA-F]{6}$/),
    ])
    .nullable()
    .optional(),
});

async function resolveProjectPath(store: ProjectStore, projectId: string): Promise<string> {
  const tracker = await store.readTracker();
  const entry = tracker.projects.find((p) => p.id === projectId);
  if (!entry) throw { statusCode: 404, message: `Project not found: ${projectId}` };
  return entry.path;
}

export async function registerStoryboardRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { store } = deps;
  const assetsDir = deps.assetsDir ?? defaultAssetsDir();

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

  // PUT /api/projects/:id/storyboard/defaults — update frame-related storyboard defaults
  app.put('/api/projects/:id/storyboard/defaults', async (req, reply) => {
    const { id } = req.params as { id: string };
    const projectPath = await resolveProjectPath(store, id);

    const parsed = FrameSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.message, code: 'invalid_request' });
    }
    const body = parsed.data;

    // Validate frame_background value (regex inside the union doesn't reject non-hex non-literals,
    // so the union itself covers that — safeParse already returned success only for valid values)
    // Validate frame_style against the manifest if provided
    if (body.frame_style != null) {
      const manifest = await loadFrameManifest(assetsDir);
      if (!getFrame(manifest, body.frame_style)) {
        return reply.status(400).send({
          error: `Unknown frame_style: ${body.frame_style}`,
          code: 'invalid_request',
        });
      }
    }

    const sb = await loadStoryboard(projectPath);
    if (!sb) return reply.status(404).send({ error: 'No storyboard found', code: 'not_found' });

    const currentDefaults = sb.defaults ?? {};

    // Apply field updates: null means clear, undefined means leave untouched
    const newDefaults = { ...currentDefaults };
    if ('frame_style' in body) {
      if (body.frame_style === null) {
        delete newDefaults.frame_style;
      } else {
        newDefaults.frame_style = body.frame_style;
      }
    }
    if ('frame_background' in body) {
      if (body.frame_background === null) {
        delete newDefaults.frame_background;
      } else {
        newDefaults.frame_background = body.frame_background;
      }
    }

    // Persist the new defaults first
    const withNewDefaults = { ...sb, defaults: newDefaults };
    await saveStoryboard(projectPath, withNewDefaults);

    // Cache busting: any defaults change (frame_style or frame_background) invalidates
    // ALL scene frame_render caches — simpler and safer than tracking which scenes inherit.
    for (const scene of withNewDefaults.scenes) {
      if (scene.frame_render) {
        const cachePath = join(projectPath, scene.frame_render);
        await rm(cachePath, { force: true });
      }
    }
    const cleared = {
      ...withNewDefaults,
      scenes: withNewDefaults.scenes.map((s) => {
        if (!s.frame_render) return s;
        const { frame_render: _ignored, ...rest } = s;
        return rest as typeof s;
      }),
    };
    await saveStoryboard(projectPath, cleared);
    return cleared;
  });

  // PATCH /api/projects/:id/scenes/:sceneId/frame — update per-scene frame settings
  app.patch('/api/projects/:id/scenes/:sceneId/frame', async (req, reply) => {
    const { id, sceneId } = req.params as { id: string; sceneId: string };
    const projectPath = await resolveProjectPath(store, id);

    const parsed = FrameSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.message, code: 'invalid_request' });
    }
    const body = parsed.data;

    // Validate frame_style against the manifest if provided and non-null
    if (body.frame_style != null) {
      const manifest = await loadFrameManifest(assetsDir);
      if (!getFrame(manifest, body.frame_style)) {
        return reply.status(400).send({
          error: `Unknown frame_style: ${body.frame_style}`,
          code: 'invalid_request',
        });
      }
    }

    const sb = await loadStoryboard(projectPath);
    if (!sb) return reply.status(404).send({ error: 'No storyboard found', code: 'not_found' });

    const scene = sb.scenes.find((s) => s.id === sceneId);
    if (!scene) {
      return reply.status(404).send({ error: `Scene not found: ${sceneId}`, code: 'scene_not_found' });
    }

    // Cache busting: if the scene has a frame_render, delete the file and clear the field
    if (scene.frame_render) {
      const frameRenderPath = join(projectPath, scene.frame_render);
      await rm(frameRenderPath, { force: true });
    }

    // Build the scene patch — null values clear fields, undefined leaves them untouched
    const patch: Partial<Scene> = { frame_render: undefined };
    if ('frame_style' in body) {
      patch.frame_style = body.frame_style ?? undefined;
    }
    if ('frame_background' in body) {
      patch.frame_background = body.frame_background ?? undefined;
    }

    // When clearing frame_render we must explicitly pass undefined so spread overwrites existing
    const updatedScene: Scene = { ...scene, ...patch, frame_render: undefined, id: sceneId };
    const scenes = sb.scenes.map((s) => (s.id === sceneId ? updatedScene : s));
    const updated = { ...sb, scenes };
    await saveStoryboard(projectPath, updated);

    return updatedScene;
  });

}
