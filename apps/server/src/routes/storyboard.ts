import type { FastifyInstance, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { z } from 'zod';
import { SceneSchema, type Scene } from '@vpa/shared';
import type { ProjectStore } from '../services/project/store.js';
import {
  loadStoryboard,
  mutateStoryboard,
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
  // Project-default narration emotiveness. null clears it (scenes fall back to
  // the 'medium' baseline).
  tts_expressiveness: z.enum(['light', 'medium', 'heavy']).nullable().optional(),
});

async function resolveProjectPath(store: ProjectStore, projectId: string): Promise<string> {
  const tracker = await store.readTracker();
  const entry = tracker.projects.find((p) => p.id === projectId);
  if (!entry) throw { statusCode: 404, message: `Project not found: ${projectId}` };
  return entry.path;
}

class StoryboardMutationError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function requireStoryboard(current: import('@vpa/shared').Storyboard | null) {
  if (!current) throw new StoryboardMutationError(404, 'not_found', 'No storyboard found');
  return current;
}

function sendMutationError(reply: FastifyReply, error: unknown) {
  if (!(error instanceof StoryboardMutationError)) throw error;
  return reply.status(error.statusCode).send({ error: error.message, code: error.code });
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
    return mutateStoryboard(projectPath, () => storyboard);
  });

  // POST /api/projects/:id/storyboard/scenes — add a scene
  app.post('/api/projects/:id/storyboard/scenes', async (req, reply) => {
    const { id } = req.params as { id: string };
    const projectPath = await resolveProjectPath(store, id);
    const input = req.body as Partial<Scene> & { name: string; description: string };
    const scene: Scene = SceneSchema.parse({
      id: input.id ?? `scene-${randomUUID().slice(0, 8)}`,
      name: input.name,
      description: input.description,
      type: input.type ?? 'desktop',
    });

    try {
      return await mutateStoryboard(projectPath, (current) => addScene(requireStoryboard(current), scene));
    } catch (error) {
      return sendMutationError(reply, error);
    }
  });

  // PUT /api/projects/:id/storyboard/reorder — reorder scenes
  // NOTE: registered before :sceneId routes to avoid path collision
  app.put('/api/projects/:id/storyboard/reorder', async (req, reply) => {
    const { id } = req.params as { id: string };
    const projectPath = await resolveProjectPath(store, id);
    const { orderedIds } = req.body as { orderedIds: string[] };
    if (!Array.isArray(orderedIds)) {
      return reply.status(400).send({ error: 'orderedIds must be an array', code: 'invalid_request' });
    }

    try {
      return await mutateStoryboard(projectPath, (current) => {
        const storyboard = requireStoryboard(current);
        try {
          return reorderScenes(storyboard, orderedIds);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new StoryboardMutationError(400, 'reorder_failed', message);
        }
      });
    } catch (err) {
      return sendMutationError(reply, err);
    }
  });

  // PUT /api/projects/:id/storyboard/scenes/:sceneId — update a scene
  app.put('/api/projects/:id/storyboard/scenes/:sceneId', async (req, reply) => {
    const { id, sceneId } = req.params as { id: string; sceneId: string };
    const projectPath = await resolveProjectPath(store, id);
    try {
      return await mutateStoryboard(projectPath, (current) => {
        const storyboard = requireStoryboard(current);
        try {
          return updateScene(storyboard, sceneId, req.body as Partial<Scene>);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new StoryboardMutationError(404, 'scene_not_found', message);
        }
      });
    } catch (err) {
      return sendMutationError(reply, err);
    }
  });

  // DELETE /api/projects/:id/storyboard/scenes/:sceneId — remove a scene
  app.delete('/api/projects/:id/storyboard/scenes/:sceneId', async (req, reply) => {
    const { id, sceneId } = req.params as { id: string; sceneId: string };
    const projectPath = await resolveProjectPath(store, id);
    try {
      return await mutateStoryboard(projectPath, (current) => {
        const storyboard = requireStoryboard(current);
        try {
          return removeScene(storyboard, sceneId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new StoryboardMutationError(404, 'scene_not_found', message);
        }
      });
    } catch (err) {
      return sendMutationError(reply, err);
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

    const cachePaths: string[] = [];
    let updated;
    try {
      updated = await mutateStoryboard(projectPath, (current) => {
        const storyboard = requireStoryboard(current);
        const newDefaults = { ...(storyboard.defaults ?? {}) };
        if ('frame_style' in body) {
          if (body.frame_style === null) delete newDefaults.frame_style;
          else newDefaults.frame_style = body.frame_style;
        }
        if ('frame_background' in body) {
          if (body.frame_background === null) delete newDefaults.frame_background;
          else newDefaults.frame_background = body.frame_background;
        }
        if ('tts_expressiveness' in body) {
          if (body.tts_expressiveness === null) delete newDefaults.tts_expressiveness;
          else newDefaults.tts_expressiveness = body.tts_expressiveness;
        }

        const frameChanged = 'frame_style' in body || 'frame_background' in body;
        const scenes = frameChanged
          ? storyboard.scenes.map((scene) => {
              if (!scene.frame_render) return scene;
              cachePaths.push(join(projectPath, scene.frame_render));
              const cleared = { ...scene };
              delete cleared.frame_render;
              return cleared;
            })
          : storyboard.scenes;
        return { ...storyboard, defaults: newDefaults, scenes };
      });
    } catch (error) {
      return sendMutationError(reply, error);
    }
    for (const cachePath of cachePaths) await rm(cachePath, { force: true });
    return updated;
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

    let frameRenderPath: string | undefined;
    let updated;
    try {
      updated = await mutateStoryboard(projectPath, (current) => {
        const storyboard = requireStoryboard(current);
        const scene = storyboard.scenes.find((candidate) => candidate.id === sceneId);
        if (!scene) {
          throw new StoryboardMutationError(404, 'scene_not_found', `Scene not found: ${sceneId}`);
        }
        if (scene.frame_render) frameRenderPath = join(projectPath, scene.frame_render);
        const patch: Partial<Scene> = { frame_render: undefined };
        if ('frame_style' in body) patch.frame_style = body.frame_style ?? undefined;
        if ('frame_background' in body) patch.frame_background = body.frame_background ?? undefined;
        const updatedScene: Scene = { ...scene, ...patch, frame_render: undefined, id: sceneId };
        return {
          ...storyboard,
          scenes: storyboard.scenes.map((candidate) => candidate.id === sceneId ? updatedScene : candidate),
        };
      });
    } catch (error) {
      return sendMutationError(reply, error);
    }
    if (frameRenderPath) await rm(frameRenderPath, { force: true });
    return updated.scenes.find((scene) => scene.id === sceneId)!;
  });

}
