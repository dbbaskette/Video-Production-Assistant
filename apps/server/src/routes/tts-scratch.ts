import type { FastifyInstance } from 'fastify';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TtsService } from '../services/tts/index.js';

interface Deps {
  vpaHome: string;
  tts: TtsService;
}

const MAX_TEXT_CHARS = 5000;
const MAX_CLIPS_KEPT = 50;

interface ScratchClip {
  id: string;
  createdAt: string;
  engine: string;
  voice: string;
  speed: number;
  text: string;
  durationSec: number;
  format: 'mp3' | 'wav';
  bytes: number;
}

function scratchDir(vpaHome: string): string {
  return join(vpaHome, 'tts-scratch');
}

function detectFormat(buf: Buffer): 'mp3' | 'wav' {
  return buf.length >= 4 && buf.toString('ascii', 0, 4) === 'RIFF' ? 'wav' : 'mp3';
}

function newId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}-${rand}`;
}

async function readSidecar(path: string): Promise<ScratchClip | null> {
  try {
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw) as ScratchClip;
  } catch {
    return null;
  }
}

async function listClips(dir: string): Promise<ScratchClip[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const clips: ScratchClip[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const clip = await readSidecar(join(dir, entry));
    if (clip) clips.push(clip);
  }
  clips.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return clips;
}

async function pruneOldest(dir: string, keep: number): Promise<void> {
  const clips = await listClips(dir);
  const stale = clips.slice(keep);
  for (const clip of stale) {
    await rm(join(dir, `${clip.id}.${clip.format}`), { force: true });
    await rm(join(dir, `${clip.id}.json`), { force: true });
  }
}

export async function registerTtsScratchRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const dir = scratchDir(deps.vpaHome);
  await mkdir(dir, { recursive: true });

  // GET /api/tts/scratch — list recent scratch clips, newest first
  app.get('/api/tts/scratch', async () => listClips(dir));

  // POST /api/tts/scratch — synthesize text and persist to disk
  app.post('/api/tts/scratch', async (req, reply) => {
    const body = (req.body ?? {}) as {
      engine?: string;
      voice?: string;
      text?: string;
      speed?: number;
    };
    const engine = (body.engine ?? '').trim();
    const voice = (body.voice ?? '').trim();
    const text = (body.text ?? '').trim();
    const speed = typeof body.speed === 'number' && body.speed > 0 ? body.speed : 1.0;

    if (!engine || !voice) {
      return reply.status(400).send({ error: 'engine and voice are required', code: 'invalid_request' });
    }
    if (!text) {
      return reply.status(400).send({ error: 'text must not be empty', code: 'invalid_request' });
    }
    if (text.length > MAX_TEXT_CHARS) {
      return reply.status(400).send({
        error: `text must be ${MAX_TEXT_CHARS} characters or fewer`,
        code: 'text_too_long',
      });
    }
    if (!deps.tts.getProvider(engine)) {
      return reply.status(400).send({
        error: `TTS engine not registered: ${engine}`,
        code: 'engine_unavailable',
      });
    }

    let result;
    try {
      result = await deps.tts.generate(engine, text, { voice, speed });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = /\(403\b/.test(message) ? 403 : /\(401\b/.test(message) ? 401 : 502;
      return reply.status(status).send({ error: message.slice(0, 500), code: 'synthesis_failed' });
    }

    const id = newId();
    const format = detectFormat(result.audio);
    const audioPath = join(dir, `${id}.${format}`);
    const sidecarPath = join(dir, `${id}.json`);
    const clip: ScratchClip = {
      id,
      createdAt: new Date().toISOString(),
      engine,
      voice,
      speed,
      text,
      durationSec: result.durationSec,
      format,
      bytes: result.audio.length,
    };
    await writeFile(audioPath, result.audio);
    await writeFile(sidecarPath, JSON.stringify(clip, null, 2), 'utf-8');
    void pruneOldest(dir, MAX_CLIPS_KEPT).catch(() => undefined);
    return clip;
  });

  // GET /api/tts/scratch/:id/audio — stream the audio file
  app.get('/api/tts/scratch/:id/audio', async (req, reply) => {
    const { id } = req.params as { id: string };
    const clip = await readSidecar(join(dir, `${id}.json`));
    if (!clip) {
      return reply.status(404).send({ error: 'Clip not found', code: 'not_found' });
    }
    const audioPath = join(dir, `${id}.${clip.format}`);
    const fileStat = await stat(audioPath).catch(() => null);
    if (!fileStat) {
      return reply.status(404).send({ error: 'Audio file missing', code: 'not_found' });
    }
    reply.header('Content-Type', clip.format === 'wav' ? 'audio/wav' : 'audio/mpeg');
    reply.header('Content-Length', fileStat.size);
    reply.header('Cache-Control', 'no-store');
    return reply.send(createReadStream(audioPath));
  });

  // DELETE /api/tts/scratch/:id — remove a clip
  app.delete('/api/tts/scratch/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const clip = await readSidecar(join(dir, `${id}.json`));
    if (!clip) {
      return reply.status(404).send({ error: 'Clip not found', code: 'not_found' });
    }
    await rm(join(dir, `${id}.${clip.format}`), { force: true });
    await rm(join(dir, `${id}.json`), { force: true });
    return { deleted: true };
  });
}
