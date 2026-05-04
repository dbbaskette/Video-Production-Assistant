import type { FastifyInstance } from 'fastify';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { ProjectStore } from '../services/project/store.js';
import { generateMusic, LyriaError, type LyriaModel } from '../services/music/lyria.js';
import {
  audioPathFor,
  deleteTrack,
  listTracks,
  readTrack,
  saveTrack,
  trackAudioExists,
} from '../services/music/store.js';
import { jobQueue } from '../lib/job-queue.js';

interface Deps {
  store: ProjectStore;
}

const STATUS_FOR: Record<LyriaError['code'], number> = {
  unauthorized: 401,
  forbidden: 403,
  rate_limited: 429,
  safety_blocked: 400,
  invalid_request: 400,
  no_audio: 502,
  unknown: 502,
};

async function resolveProjectPath(store: ProjectStore, projectId: string): Promise<string> {
  const tracker = await store.readTracker();
  const entry = tracker.projects.find((p) => p.id === projectId);
  if (!entry) throw { statusCode: 404, message: `Project not found: ${projectId}` };
  return entry.path;
}

export async function registerMusicRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { store } = deps;

  // GET /api/projects/:id/music — list generated tracks for this project
  app.get('/api/projects/:id/music', async (req, reply) => {
    const { id } = req.params as { id: string };
    let projectPath: string;
    try {
      projectPath = await resolveProjectPath(store, id);
    } catch (err) {
      const e = err as { statusCode?: number; message?: string };
      return reply.status(e.statusCode ?? 500).send({ error: e.message, code: 'not_found' });
    }
    return listTracks(projectPath);
  });

  // POST /api/projects/:id/music/generate — kick off a Lyria generation job
  // body: { prompt, model: 'clip' | 'pro', format?: 'mp3' | 'wav' }
  // Returns { jobId } immediately; the SSE stream emits 'progress' (started),
  // 'done' (with the saved track), and 'error' as appropriate.
  app.post('/api/projects/:id/music/generate', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as {
      prompt?: string;
      model?: LyriaModel;
      format?: 'mp3' | 'wav';
    };
    const prompt = (body.prompt ?? '').trim();
    if (!prompt) {
      return reply.status(400).send({ error: 'prompt is required', code: 'invalid_request' });
    }
    if (prompt.length > 1500) {
      return reply.status(400).send({ error: 'prompt is too long (max 1500 chars)', code: 'invalid_request' });
    }
    const model: LyriaModel = body.model === 'pro' ? 'pro' : 'clip';
    const format: 'mp3' | 'wav' = body.format === 'wav' && model === 'pro' ? 'wav' : 'mp3';

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return reply.status(403).send({
        error: 'GEMINI_API_KEY is not set — Lyria music generation is disabled.',
        code: 'no_api_key',
      });
    }

    let projectPath: string;
    try {
      projectPath = await resolveProjectPath(store, id);
    } catch (err) {
      const e = err as { statusCode?: number; message?: string };
      return reply.status(e.statusCode ?? 500).send({ error: e.message, code: 'not_found' });
    }

    const job = jobQueue.create('music-generate');
    jobQueue.setStatus(job.id, 'running');
    jobQueue.emit(job.id, 'start', { projectId: id, model, format, prompt });
    jobQueue.emit(job.id, 'progress', {
      type: 'step',
      message: `Generating with ${model === 'pro' ? 'Lyria 3 Pro' : 'Lyria 3 Clip'}…`,
    });

    void (async () => {
      try {
        const result = await generateMusic({ prompt, model, format }, apiKey);
        const track = await saveTrack(projectPath, {
          audio: result.audio,
          prompt,
          model,
          modelId: result.modelId,
          format,
          lyrics: result.lyrics,
        });
        jobQueue.complete(job.id, { track });
      } catch (err) {
        if (err instanceof LyriaError) {
          jobQueue.fail(job.id, `${err.code}: ${err.message}`);
        } else {
          jobQueue.fail(job.id, err instanceof Error ? err.message : String(err));
        }
      }
    })();

    return { jobId: job.id, status: 'running' };
  });

  // GET /api/projects/:id/music/:trackId/audio — stream the track audio
  app.get('/api/projects/:id/music/:trackId/audio', async (req, reply) => {
    const { id, trackId } = req.params as { id: string; trackId: string };
    let projectPath: string;
    try {
      projectPath = await resolveProjectPath(store, id);
    } catch (err) {
      const e = err as { statusCode?: number; message?: string };
      return reply.status(e.statusCode ?? 500).send({ error: e.message, code: 'not_found' });
    }
    const track = await readTrack(projectPath, trackId);
    if (!track || !(await trackAudioExists(projectPath, track))) {
      return reply.status(404).send({ error: 'Track not found', code: 'not_found' });
    }
    const path = audioPathFor(projectPath, track);
    const fileStat = await stat(path);
    reply.header('Content-Type', track.format === 'wav' ? 'audio/wav' : 'audio/mpeg');
    reply.header('Content-Length', fileStat.size);
    reply.header('Cache-Control', 'private, max-age=60');
    return reply.send(createReadStream(path));
  });

  // DELETE /api/projects/:id/music/:trackId — remove a track
  app.delete('/api/projects/:id/music/:trackId', async (req, reply) => {
    const { id, trackId } = req.params as { id: string; trackId: string };
    let projectPath: string;
    try {
      projectPath = await resolveProjectPath(store, id);
    } catch (err) {
      const e = err as { statusCode?: number; message?: string };
      return reply.status(e.statusCode ?? 500).send({ error: e.message, code: 'not_found' });
    }
    const ok = await deleteTrack(projectPath, trackId);
    if (!ok) return reply.status(404).send({ error: 'Track not found', code: 'not_found' });
    return { deleted: true };
  });
}

// Re-export so the render service can map a track id → on-disk path.
export { audioPathFor as resolveTrackAudioPath, readTrack as readMusicTrack } from '../services/music/store.js';
// Suppress unused-export lint warnings if STATUS_FOR ends up not needed here.
void STATUS_FOR;
