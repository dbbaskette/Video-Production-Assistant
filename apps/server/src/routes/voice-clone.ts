import type { FastifyInstance } from 'fastify';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { VoiceCloneStore } from '../services/voice-clone/store.js';
import { transcodeToCanonicalWav, probeDuration } from '../services/voice-clone/transcode.js';
import {
  XaiVoiceClient,
  XaiVoiceError,
  consoleVoiceLibraryUrl,
} from '../services/voice-clone/providers/xai.js';
import { VoiceCloneUpdateSchema } from '@vpa/shared';
import type { TtsService } from '../services/tts/index.js';

interface Deps {
  vpaHome: string;
  tts: TtsService;
}

/** Maximum preview text length in characters — keeps API spend predictable. */
const PREVIEW_MAX_CHARS = 400;
const DEFAULT_PREVIEW_TEXT = "Hi, I'm a sample of how I sound. This is what I'd be like in your narration.";

/** Mapping from XaiVoiceError.code → HTTP status. */
const XAI_STATUS: Record<XaiVoiceError['code'], number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  limit_reached: 400,
  bad_request: 400,
  unknown: 502,
};

const VOICE_CLONE_SCRIPT = `The sun was setting behind the mountains, casting long shadows across the valley below. A gentle breeze rustled through the trees, carrying the scent of pine and wildflowers. In the distance, a river wound its way through the landscape, its surface reflecting the orange and purple hues of the evening sky.

Technology continues to reshape how we work and communicate. From cloud-native platforms to artificial intelligence, the tools we use every day are becoming more powerful and more intuitive. The key is finding the right balance between automation and human creativity.

Let me walk you through the main dashboard. Notice how the navigation is organized into clear sections. Each panel updates in real time, giving you instant visibility into your system's performance. You can customize the layout to match your workflow, and everything syncs automatically across devices.

Questions often come up about security and compliance. Our platform uses end-to-end encryption, role-based access controls, and continuous monitoring. We regularly publish audit reports and maintain certifications for SOC 2, ISO 27001, and GDPR compliance.

That wraps up our overview. The combination of speed, reliability, and ease of use makes this a compelling solution for teams of any size. I'm excited to see what you'll build with it.`;

const VOICE_CLONE_INSTRUCTIONS = `## How to Record Your Voice Clone

1. **Find a quiet room** — minimize background noise, echo, and fan hum
2. **Use a decent microphone** — a USB headset or laptop mic works, but a condenser mic is better
3. **Speak naturally** — read the script in your normal speaking voice at a comfortable pace
4. **Don't rush** — pause briefly between paragraphs
5. **Aim for 30-90 seconds** — the script above is about 60 seconds at a natural pace
6. **Record or upload** — use the in-app recorder, or import a WAV/MP3/M4A you already have

The script covers a range of tones (descriptive, technical, instructional, conversational) to give the model a well-rounded sample of your voice.`;

export async function registerVoiceCloneRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const store = new VoiceCloneStore({ vpaHome: deps.vpaHome });
  await store.migrateLegacy();

  const xaiKey = () => process.env.XAI_API_KEY;
  const xaiTeamId = () => process.env.XAI_TEAM_ID;
  const xaiClient = (): XaiVoiceClient => {
    const key = xaiKey();
    if (!key) throw new XaiVoiceError('forbidden', 403, 'XAI_API_KEY is not configured');
    return new XaiVoiceClient(key);
  };

  // ── Reading script + console URL (no params) ─────────────────────
  app.get('/api/voice-clone/script', async () => ({
    script: VOICE_CLONE_SCRIPT,
    instructions: VOICE_CLONE_INSTRUCTIONS,
  }));

  app.get('/api/voice-clone/xai/console-url', async () => consoleVoiceLibraryUrl(xaiTeamId()));

  // ── List + read ─────────────────────────────────────────────────
  app.get('/api/voice-clone', async () => {
    const voices = await store.list();
    // Backfill durationSec by probing audio files lazily
    return Promise.all(voices.map(async (v) => {
      if (v.hasAudio && !v.durationSec) {
        const dur = await probeDuration(store.audioPath(v.id));
        return { ...v, durationSec: dur };
      }
      return v;
    }));
  });

  app.get('/api/voice-clone/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const v = await store.read(id);
      if (v.hasAudio && !v.durationSec) {
        v.durationSec = await probeDuration(store.audioPath(id));
      }
      return v;
    } catch {
      return reply.status(404).send({ error: `Voice not found: ${id}`, code: 'not_found' });
    }
  });

  // ── Stream audio ────────────────────────────────────────────────
  app.get('/api/voice-clone/:id/audio', async (req, reply) => {
    const { id } = req.params as { id: string };
    const path = store.audioPath(id);
    const fileStat = await stat(path).catch(() => null);
    if (!fileStat) return reply.status(404).send({ error: 'No audio for this voice', code: 'not_found' });
    reply.header('Content-Type', 'audio/wav');
    reply.header('Content-Length', fileStat.size);
    return reply.send(createReadStream(path));
  });

  // ── Create (multipart: audio + name + optional metadata) ─────────
  app.post('/api/voice-clone', async (req, reply) => {
    const parts = req.parts();
    let audioBuffer: Buffer | undefined;
    let audioFilename = 'audio.wav';
    const fields: Record<string, string> = {};
    for await (const part of parts) {
      if (part.type === 'file') {
        const buffers: Buffer[] = [];
        for await (const chunk of part.file) buffers.push(chunk as Buffer);
        audioBuffer = Buffer.concat(buffers);
        audioFilename = part.filename || audioFilename;
      } else {
        fields[part.fieldname] = String(part.value ?? '');
      }
    }
    if (!fields.name) {
      return reply.status(400).send({ error: 'name is required', code: 'invalid_request' });
    }
    if (audioBuffer && audioBuffer.length > 0) {
      const ext = extname(audioFilename).slice(1) || 'wav';
      try {
        audioBuffer = await transcodeToCanonicalWav(audioBuffer, ext);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Transcode failed';
        return reply.status(400).send({ error: `Audio transcode failed: ${msg}`, code: 'transcode_failed' });
      }
    }

    const meta = pickMetadata(fields);
    const voice = await store.create({
      name: fields.name,
      description: fields.description || undefined,
      transcript: fields.transcript || undefined,
      audioBuffer,
      metadata: meta,
    });
    return voice;
  });

  // ── Replace audio ───────────────────────────────────────────────
  app.put('/api/voice-clone/:id/audio', async (req, reply) => {
    const { id } = req.params as { id: string };
    const data = await req.file();
    if (!data) return reply.status(400).send({ error: 'No file uploaded', code: 'invalid_request' });
    const buffers: Buffer[] = [];
    for await (const chunk of data.file) buffers.push(chunk as Buffer);
    const ext = extname(data.filename || '').slice(1) || 'wav';
    let wav: Buffer;
    try {
      wav = await transcodeToCanonicalWav(Buffer.concat(buffers), ext);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Transcode failed';
      return reply.status(400).send({ error: `Audio transcode failed: ${msg}`, code: 'transcode_failed' });
    }
    return store.replaceAudio(id, wav);
  });

  // ── PATCH metadata ──────────────────────────────────────────────
  app.patch('/api/voice-clone/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = VoiceCloneUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.message, code: 'invalid_request' });
    }
    try {
      return await store.update(id, parsed.data);
    } catch {
      return reply.status(404).send({ error: `Voice not found: ${id}`, code: 'not_found' });
    }
  });

  // ── Save transcript shorthand (kept for backward compatibility) ──
  app.put('/api/voice-clone/:id/transcript', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { transcript } = (req.body ?? {}) as { transcript?: string };
    try {
      return await store.update(id, { transcript: transcript ?? null });
    } catch {
      return reply.status(404).send({ error: `Voice not found: ${id}`, code: 'not_found' });
    }
  });

  // ── Delete (optionally cascade to xAI) ───────────────────────────
  app.delete('/api/voice-clone/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { cascade } = req.query as { cascade?: string };
    let xaiDeleteError: string | undefined;
    if (cascade === 'xai') {
      try {
        const v = await store.read(id);
        const reg = v.providers.xai;
        if (reg && xaiKey()) {
          await xaiClient().delete(reg.voice_id);
        }
      } catch (err) {
        xaiDeleteError = err instanceof Error ? err.message : String(err);
        // Don't abort local delete — surface the error in the response
      }
    }
    await store.delete(id);
    return { deleted: true, xaiDeleteError };
  });

  // ── xAI: register, unregister, manual import ─────────────────────
  app.post('/api/voice-clone/:id/register/xai', async (req, reply) => {
    const { id } = req.params as { id: string };
    let voice;
    try {
      voice = await store.read(id);
    } catch {
      return reply.status(404).send({ error: `Voice not found: ${id}`, code: 'not_found' });
    }
    if (!voice.hasAudio) {
      return reply.status(400).send({
        error: 'Voice has no audio file — record or upload first',
        code: 'no_audio',
      });
    }
    if (!xaiKey()) {
      return reply.status(403).send({
        error: 'XAI_API_KEY is not configured. Use the manual-import flow or set the env var.',
        code: 'xai_key_missing',
      });
    }
    try {
      const audioBuffer = await import('node:fs/promises').then((fs) =>
        fs.readFile(store.audioPath(id)),
      );
      const result = await xaiClient().create(
        { buffer: audioBuffer, filename: 'audio.wav', mime: 'audio/wav' },
        {
          name: voice.name,
          description: voice.description,
          gender: voice.gender,
          accent: voice.accent,
          age: voice.age,
          language: voice.language,
          use_case: voice.use_case,
          tone: voice.tone,
        },
      );
      return await store.setXaiRegistration(id, result.voice_id);
    } catch (err) {
      if (err instanceof XaiVoiceError) {
        return reply.status(XAI_STATUS[err.code]).send({
          error: err.message,
          code: `xai_${err.code}`,
        });
      }
      throw err;
    }
  });

  app.delete('/api/voice-clone/:id/register/xai', async (req, reply) => {
    const { id } = req.params as { id: string };
    let voice;
    try {
      voice = await store.read(id);
    } catch {
      return reply.status(404).send({ error: `Voice not found: ${id}`, code: 'not_found' });
    }
    const reg = voice.providers.xai;
    if (!reg) return store.read(id); // no-op
    if (xaiKey()) {
      try {
        await xaiClient().delete(reg.voice_id);
      } catch (err) {
        // Not fatal — still clear our registration so user isn't stuck
        if (!(err instanceof XaiVoiceError) || err.code !== 'not_found') {
          app.log.warn(`xAI delete failed: ${err instanceof Error ? err.message : err}`);
        }
      }
    }
    return store.clearXaiRegistration(id);
  });

  app.post('/api/voice-clone/:id/import/xai', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { voice_id } = (req.body ?? {}) as { voice_id?: string };
    if (!voice_id || typeof voice_id !== 'string' || voice_id.trim().length === 0) {
      return reply.status(400).send({ error: 'voice_id is required', code: 'invalid_request' });
    }
    const trimmed = voice_id.trim();
    // If we have an API key, sanity-check the voice exists. Otherwise trust the user.
    if (xaiKey()) {
      try {
        const exists = await xaiClient().exists(trimmed);
        if (!exists) {
          return reply.status(404).send({
            error: `voice_id not found in your xAI account: ${trimmed}`,
            code: 'xai_voice_not_found',
          });
        }
      } catch (err) {
        if (err instanceof XaiVoiceError && err.code === 'forbidden') {
          // Can't verify with this key; allow import anyway (read may also be Enterprise-gated)
          app.log.info(`xAI voice exists() forbidden — importing without verification`);
        } else if (err instanceof XaiVoiceError) {
          return reply.status(XAI_STATUS[err.code]).send({
            error: err.message,
            code: `xai_${err.code}`,
          });
        } else {
          throw err;
        }
      }
    }
    try {
      return await store.setXaiRegistration(id, trimmed, { imported: true });
    } catch {
      return reply.status(404).send({ error: `Voice not found: ${id}`, code: 'not_found' });
    }
  });

  // ── POST /api/voice-clone/:id/preview ─────────────────────────────
  // Synthesize a short sample of this voice on the requested provider
  // and stream the resulting MP3 back. Used by the Voice detail page's
  // "Preview voice" buttons — no project context needed.
  app.post('/api/voice-clone/:id/preview', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { provider?: 'fish' | 'xai'; text?: string };
    const provider = body.provider;
    if (provider !== 'fish' && provider !== 'xai') {
      return reply.status(400).send({
        error: "provider must be 'fish' or 'xai'",
        code: 'invalid_request',
      });
    }
    const text = (body.text ?? DEFAULT_PREVIEW_TEXT).trim().slice(0, PREVIEW_MAX_CHARS);
    if (text.length === 0) {
      return reply.status(400).send({ error: 'text must not be empty', code: 'invalid_request' });
    }

    let voice;
    try {
      voice = await store.read(id);
    } catch {
      return reply.status(404).send({ error: `Voice not found: ${id}`, code: 'not_found' });
    }

    let engineId: string;
    let voiceId: string;
    if (provider === 'fish') {
      if (!voice.hasAudio) {
        return reply.status(400).send({
          error: 'No local audio for this voice — record or upload first',
          code: 'no_audio',
        });
      }
      if (!deps.tts.getProvider('fish')) {
        return reply.status(503).send({
          error: 'Fish Audio TTS provider is not registered. See /setup.',
          code: 'provider_unavailable',
        });
      }
      engineId = 'fish';
      voiceId = `clone:${voice.id}`;
    } else {
      const xaiReg = voice.providers.xai;
      if (!xaiReg) {
        return reply.status(400).send({
          error: 'This voice is not registered with xAI',
          code: 'not_registered',
        });
      }
      if (!deps.tts.getProvider('xai')) {
        return reply.status(503).send({
          error: 'xAI TTS provider is not registered. Set XAI_API_KEY in .env.',
          code: 'provider_unavailable',
        });
      }
      engineId = 'xai';
      voiceId = xaiReg.voice_id;
    }

    try {
      const result = await deps.tts.generate(engineId, text, { voice: voiceId, speed: 1.0 });
      reply.header('Content-Type', 'audio/mpeg');
      reply.header('Content-Length', result.audio.length);
      reply.header('Cache-Control', 'no-store');
      return reply.send(result.audio);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Map xAI 403 (Enterprise / feature-not-enabled) to a clearer status
      const status = /\(403\b/.test(message) ? 403 : /\(401\b/.test(message) ? 401 : 502;
      return reply.status(status).send({
        error: message.slice(0, 500),
        code: 'preview_failed',
      });
    }
  });
}

function pickMetadata(fields: Record<string, string>) {
  const keys = ['gender', 'age', 'accent', 'language', 'use_case', 'tone', 'description'] as const;
  const out: Record<string, string> = {};
  for (const k of keys) {
    if (fields[k]) out[k] = fields[k]!;
  }
  return out;
}
