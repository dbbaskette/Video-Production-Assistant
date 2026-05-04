import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { ProjectStore } from '../services/project/store.js';
import { loadStoryboard, saveStoryboard, updateScene } from '../services/storyboard/index.js';
import { renderLowerThirdsOverlay, OverlayRenderError } from '../services/overlay/render.js';
import { projectFiles } from '../services/project/paths.js';

interface OverlayRouteDeps {
  store: ProjectStore;
  workspaceRoot: string;
}

async function resolveProject(store: ProjectStore, projectId: string) {
  const tracker = await store.readTracker();
  const entry = tracker.projects.find((p) => p.id === projectId);
  if (!entry) throw { statusCode: 404, message: `Project not found: ${projectId}` };
  return entry;
}

export async function registerOverlayRoutes(
  app: FastifyInstance,
  deps: OverlayRouteDeps,
): Promise<void> {
  const { store } = deps;

  // ──────────────────── POST /api/projects/:id/scenes/:sceneId/overlay/render ────────────────────
  app.post<{ Params: { id: string; sceneId: string } }>(
    '/api/projects/:id/scenes/:sceneId/overlay/render',
    async (req, reply) => {
      const { id, sceneId } = req.params;

      // 1. Resolve project
      const entry = await resolveProject(store, id);

      // 2. Load storyboard and verify scene exists
      const sb = await loadStoryboard(entry.path);
      if (!sb) {
        return reply.status(404).send({ error: 'Storyboard not found', code: 'no_storyboard' });
      }

      const scene = sb.scenes.find((s) => s.id === sceneId);
      if (!scene) {
        return reply.status(404).send({ error: `Scene not found: ${sceneId}`, code: 'no_scene' });
      }

      // 3. Verify the scene has a recording
      if (!scene.recording?.source) {
        return reply.status(400).send({
          error: 'Scene has no recording. Upload a recording first.',
          code: 'no_recording',
        });
      }

      // 4. Get lower-thirds from the scene
      if (!scene.lower_thirds || scene.lower_thirds.length === 0) {
        return reply.status(400).send({
          error: 'Scene has no lower thirds configured.',
          code: 'no_lower_thirds',
        });
      }

      // 5. Build absolute recording path
      const files = projectFiles(entry.path);
      const recordingAbsolute = join(entry.path, scene.recording.source);

      // 6. Call render service
      let result;
      try {
        result = await renderLowerThirdsOverlay({
          projectPath: entry.path,
          sceneId,
          recordingPath: recordingAbsolute,
          lowerThirds: scene.lower_thirds,
        });
      } catch (err) {
        if (err instanceof OverlayRenderError) {
          return reply.status(500).send({
            error: err.message,
            code: 'overlay_render_failed',
            hint: err.hint,
            stderrTail: err.stderrTail,
          });
        }
        throw err;
      }

      // 7. Update storyboard with overlay_render path
      const updated = updateScene(sb, sceneId, {
        overlay_render: result.outputPath,
      });
      await saveStoryboard(entry.path, updated);

      return { outputPath: result.outputPath, durationSec: result.durationSec };
    },
  );

  // ──────────────────── GET /api/projects/:id/scenes/:sceneId/overlay/video ────────────────────
  app.get<{ Params: { id: string; sceneId: string } }>(
    '/api/projects/:id/scenes/:sceneId/overlay/video',
    async (req, reply) => {
      const { id, sceneId } = req.params;

      const entry = await resolveProject(store, id);

      const sb = await loadStoryboard(entry.path);
      if (!sb) {
        return reply.status(404).send({ error: 'Storyboard not found', code: 'no_storyboard' });
      }

      const scene = sb.scenes.find((s) => s.id === sceneId);
      if (!scene) {
        return reply.status(404).send({ error: `Scene not found: ${sceneId}`, code: 'no_scene' });
      }

      if (!scene.overlay_render) {
        return reply.status(404).send({
          error: 'No rendered overlay for this scene.',
          code: 'no_overlay',
        });
      }

      const videoPath = join(entry.path, scene.overlay_render);

      try {
        await stat(videoPath);
      } catch {
        return reply.status(404).send({ error: 'Overlay video file not found on disk.', code: 'file_missing' });
      }

      reply.header('Content-Type', 'video/mp4');
      return reply.send(createReadStream(videoPath));
    },
  );
}
