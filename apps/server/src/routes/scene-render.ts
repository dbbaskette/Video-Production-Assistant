/**
 * Per-scene render routes — produce / fetch the three deliverables in
 *   <projectRoot>/renders/scenes/<sceneId>/{combined.mp4,overlay.mp4,narration.mp3}
 *
 * These are intentionally separate from the project-level render
 * (`routes/render.ts`) because they're independent operations: the project
 * render concats every scene into final.mp4; this one produces a folder of
 * grab-and-go assets for one scene. There's no SSE here — single-scene
 * renders typically finish in seconds, so the response is synchronous and
 * the web UI just shows a blocking modal during the call.
 */

import type { FastifyInstance } from 'fastify';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProjectStore } from '../services/project/store.js';
import {
  renderSingleScene,
  type SingleSceneRenderOptions,
} from '../services/render/scene-render.js';
import { RenderError } from '../services/render/index.js';

interface Deps {
  store: ProjectStore;
  vpaHome: string;
  workspaceRoot: string;
}

async function resolveProjectPath(store: ProjectStore, projectId: string): Promise<string> {
  const tracker = await store.readTracker();
  const entry = tracker.projects.find((p) => p.id === projectId);
  if (!entry) throw { statusCode: 404, message: `Project not found: ${projectId}` };
  return entry.path;
}

const KIND_TO_FILE: Record<string, { rel: string; mime: string }> = {
  combined: { rel: 'combined.mp4', mime: 'video/mp4' },
  overlay: { rel: 'overlay.mp4', mime: 'video/mp4' },
  narration: { rel: 'narration.mp3', mime: 'audio/mpeg' },
};

export async function registerSceneRenderRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { store } = deps;

  // POST /api/projects/:id/scenes/:sceneId/render — kick the per-scene render
  // and return paths once everything's on disk. Synchronous (no jobQueue).
  app.post<{
    Params: { id: string; sceneId: string };
    Body?: SingleSceneRenderOptions;
  }>('/api/projects/:id/scenes/:sceneId/render', async (req, reply) => {
    const { id, sceneId } = req.params;
    const body = (req.body ?? {}) as SingleSceneRenderOptions;
    const opts: SingleSceneRenderOptions = {
      audioMode: body.audioMode === 'mix' ? 'mix' : 'replace',
      burnSubtitles: !!body.burnSubtitles,
    };

    let projectPath: string;
    try {
      projectPath = await resolveProjectPath(store, id);
    } catch (err) {
      const e = err as { statusCode?: number; message?: string };
      return reply.status(e.statusCode ?? 500).send({
        error: e.message ?? 'Project lookup failed',
        code: 'not_found',
      });
    }

    try {
      const result = await renderSingleScene(
        {
          projectPath,
          sceneId,
          vpaHome: deps.vpaHome,
          workspaceRoot: deps.workspaceRoot,
        },
        opts,
      );
      return {
        durationSec: result.durationSec,
        hasNarration: result.narrationPath !== null,
        hadLowerThirds: result.hadLowerThirds,
        // Relative paths for transparency / debugging — clients should hit
        // the /file/:kind endpoints rather than referencing these directly.
        combinedRel: result.combinedRel,
        overlayRel: result.overlayRel,
        narrationRel: result.narrationRel,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const hint = err instanceof RenderError ? err.hint : undefined;
      const stderrTail = err instanceof RenderError ? err.stderrTail : undefined;
      const code = /no recording|storyboard|scene not found/i.test(message)
        ? 'precondition_failed'
        : 'scene_render_failed';
      return reply
        .status(code === 'precondition_failed' ? 400 : 500)
        .send({ error: message, hint, stderrTail, code });
    }
  });

  // GET /api/projects/:id/scenes/:sceneId/render/status — which deliverables
  // exist on disk + their sizes / mtimes. Used by the UI to decide whether
  // to show "Render scene" vs "Re-render" + the three download links.
  app.get<{ Params: { id: string; sceneId: string } }>(
    '/api/projects/:id/scenes/:sceneId/render/status',
    async (req, reply) => {
      const { id, sceneId } = req.params;
      let projectPath: string;
      try {
        projectPath = await resolveProjectPath(store, id);
      } catch (err) {
        const e = err as { statusCode?: number; message?: string };
        return reply.status(e.statusCode ?? 500).send({ error: e.message, code: 'not_found' });
      }
      const dir = join(projectPath, 'renders', 'scenes', sceneId);
      const files: Record<string, { exists: boolean; sizeBytes?: number; modifiedAt?: string }> = {};
      for (const [kind, info] of Object.entries(KIND_TO_FILE)) {
        try {
          const s = await stat(join(dir, info.rel));
          files[kind] = { exists: true, sizeBytes: s.size, modifiedAt: s.mtime.toISOString() };
        } catch {
          files[kind] = { exists: false };
        }
      }
      return { files };
    },
  );

  // GET /api/projects/:id/scenes/:sceneId/render/file/:kind — range-streams
  // one of {combined, overlay, narration}. Range support lets the <video>
  // tag scrub without buffering the whole file.
  app.get<{ Params: { id: string; sceneId: string; kind: string } }>(
    '/api/projects/:id/scenes/:sceneId/render/file/:kind',
    async (req, reply) => {
      const { id, sceneId, kind } = req.params;
      const info = KIND_TO_FILE[kind];
      if (!info) {
        return reply.status(404).send({ error: `Unknown render kind: ${kind}`, code: 'not_found' });
      }
      let projectPath: string;
      try {
        projectPath = await resolveProjectPath(store, id);
      } catch (err) {
        const e = err as { statusCode?: number; message?: string };
        return reply.status(e.statusCode ?? 500).send({ error: e.message, code: 'not_found' });
      }
      const filePath = join(projectPath, 'renders', 'scenes', sceneId, info.rel);
      let fileStat;
      try {
        fileStat = await stat(filePath);
      } catch {
        return reply.status(404).send({
          error: `${kind} not rendered yet`,
          code: 'no_render',
        });
      }

      const total = fileStat.size;
      const range = req.headers.range;

      if (range) {
        const m = /^bytes=(\d+)-(\d*)$/.exec(range);
        if (!m) {
          reply.header('Content-Range', `bytes */${total}`);
          return reply.status(416).send();
        }
        const start = Number.parseInt(m[1]!, 10);
        const end = m[2] && m[2].length > 0 ? Number.parseInt(m[2], 10) : total - 1;
        if (start >= total || end >= total || start > end) {
          reply.header('Content-Range', `bytes */${total}`);
          return reply.status(416).send();
        }
        reply.code(206);
        reply.header('Content-Type', info.mime);
        reply.header('Accept-Ranges', 'bytes');
        reply.header('Content-Range', `bytes ${start}-${end}/${total}`);
        reply.header('Content-Length', end - start + 1);
        return reply.send(createReadStream(filePath, { start, end }));
      }

      reply.header('Content-Type', info.mime);
      reply.header('Accept-Ranges', 'bytes');
      reply.header('Content-Length', total);
      return reply.send(createReadStream(filePath));
    },
  );
}
