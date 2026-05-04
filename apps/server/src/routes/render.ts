import type { FastifyInstance } from 'fastify';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { ProjectStore } from '../services/project/store.js';
import { renderFinalVideo, RenderError, type RenderOptions } from '../services/render/index.js';
import { jobQueue } from '../lib/job-queue.js';
import { resolveTrackAudioPath, readMusicTrack } from './music.js';

interface Deps {
  store: ProjectStore;
}

async function resolveProjectPath(store: ProjectStore, projectId: string): Promise<string> {
  const tracker = await store.readTracker();
  const entry = tracker.projects.find((p) => p.id === projectId);
  if (!entry) throw { statusCode: 404, message: `Project not found: ${projectId}` };
  return entry.path;
}

export async function registerRenderRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { store } = deps;

  // POST /api/projects/:id/render — start a render job. Returns the jobId
  // immediately; client subscribes to /api/jobs/:jobId/stream for progress.
  app.post('/api/projects/:id/render', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Partial<RenderOptions> & {
      musicTrackId?: string | null;
      musicVolumeDb?: number;
    };
    const opts: RenderOptions = {
      audioMode: body.audioMode === 'mix' ? 'mix' : 'replace',
      burnSubtitles: !!body.burnSubtitles,
    };

    let projectPath: string;
    try {
      projectPath = await resolveProjectPath(store, id);
    } catch (err) {
      const e = err as { statusCode?: number; message?: string };
      return reply.status(e.statusCode ?? 500).send({ error: e.message ?? 'Project lookup failed', code: 'not_found' });
    }

    // Resolve the music track if the caller asked for one. We accept either
    // an empty string / null for "no music" or a valid generated track id.
    if (body.musicTrackId) {
      const track = await readMusicTrack(projectPath, body.musicTrackId);
      if (!track) {
        return reply.status(400).send({
          error: `Music track not found: ${body.musicTrackId}`,
          code: 'invalid_request',
        });
      }
      opts.music = {
        audioPath: resolveTrackAudioPath(projectPath, track),
        volumeDb: typeof body.musicVolumeDb === 'number' ? body.musicVolumeDb : -20,
      };
    }

    const job = jobQueue.create('render');
    jobQueue.setStatus(job.id, 'running');
    jobQueue.emit(job.id, 'start', { projectId: id, opts });

    void (async () => {
      try {
        const result = await renderFinalVideo(projectPath, opts, (event) => {
          jobQueue.emit(job.id, 'progress', event);
        });
        jobQueue.complete(job.id, {
          projectId: id,
          outputPath: result.outputPath,
          durationSec: result.durationSec,
          sceneCount: result.scenePaths.length,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const hint = err instanceof RenderError ? err.hint : undefined;
        jobQueue.fail(job.id, hint ? `${message} — ${hint}` : message);
      }
    })();

    return { jobId: job.id, status: 'running' };
  });

  // GET /api/projects/:id/render/video — stream the rendered final.mp4 with Range
  app.get('/api/projects/:id/render/video', async (req, reply) => {
    const { id } = req.params as { id: string };
    let projectPath: string;
    try {
      projectPath = await resolveProjectPath(store, id);
    } catch (err) {
      const e = err as { statusCode?: number; message?: string };
      return reply.status(e.statusCode ?? 500).send({ error: e.message, code: 'not_found' });
    }

    const filePath = join(projectPath, 'renders', 'final.mp4');
    let fileStat;
    try {
      fileStat = await stat(filePath);
    } catch {
      return reply.status(404).send({ error: 'No rendered final.mp4 — render the project first', code: 'no_render' });
    }

    const total = fileStat.size;
    const range = req.headers.range;
    const ext = extname(filePath).toLowerCase();
    const mime = ext === '.mp4' ? 'video/mp4' : 'application/octet-stream';

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
      reply.header('Content-Type', mime);
      reply.header('Accept-Ranges', 'bytes');
      reply.header('Content-Range', `bytes ${start}-${end}/${total}`);
      reply.header('Content-Length', end - start + 1);
      return reply.send(createReadStream(filePath, { start, end }));
    }

    reply.header('Content-Type', mime);
    reply.header('Accept-Ranges', 'bytes');
    reply.header('Content-Length', total);
    return reply.send(createReadStream(filePath));
  });

  // GET /api/projects/:id/render/status — quick check whether a final.mp4 exists
  app.get('/api/projects/:id/render/status', async (req, reply) => {
    const { id } = req.params as { id: string };
    let projectPath: string;
    try {
      projectPath = await resolveProjectPath(store, id);
    } catch (err) {
      const e = err as { statusCode?: number; message?: string };
      return reply.status(e.statusCode ?? 500).send({ error: e.message, code: 'not_found' });
    }
    const filePath = join(projectPath, 'renders', 'final.mp4');
    try {
      const s = await stat(filePath);
      return { exists: true, sizeBytes: s.size, modifiedAt: s.mtime.toISOString() };
    } catch {
      return { exists: false };
    }
  });
}
