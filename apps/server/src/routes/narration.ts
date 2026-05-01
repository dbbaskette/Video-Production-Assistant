import type { FastifyInstance } from 'fastify';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProjectStore } from '../services/project/store.js';
import type { TtsService } from '../services/tts/index.js';
import { loadStoryboard, saveStoryboard, updateScene } from '../services/storyboard/index.js';
import { generateNarration, generateChunkNarration, splitIntoParagraphs } from '../services/narration/index.js';
import {
  listProfiles,
  saveProfile,
  deleteProfile,
} from '../services/voice-profile/index.js';
import type { VoiceProfile } from '../services/voice-profile/index.js';

interface Deps {
  store: ProjectStore;
  tts: TtsService;
  vpaHome: string;
}

async function resolveProjectPath(store: ProjectStore, projectId: string): Promise<string> {
  const tracker = await store.readTracker();
  const entry = tracker.projects.find((p) => p.id === projectId);
  if (!entry) throw { statusCode: 404, message: `Project not found: ${projectId}` };
  return entry.path;
}

export async function registerNarrationRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { store, tts, vpaHome } = deps;

  // GET /api/tts/engines — list available TTS engines
  app.get('/api/tts/engines', async () => {
    return tts.listEngines();
  });

  // GET /api/voices — list voice profiles
  app.get('/api/voices', async () => {
    return listProfiles(vpaHome);
  });

  // POST /api/voices — create voice profile
  app.post('/api/voices', async (req, reply) => {
    const body = req.body as Partial<VoiceProfile>;
    if (!body.name || !body.engine || !body.voice) {
      return reply
        .status(400)
        .send({ error: 'name, engine, and voice are required', code: 'invalid_request' });
    }

    const id = body.id ?? body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const profile: VoiceProfile = {
      id,
      name: body.name,
      engine: body.engine,
      voice: body.voice,
      speed: body.speed ?? 1.0,
      description: body.description,
    };

    await saveProfile(vpaHome, profile);
    return profile;
  });

  // DELETE /api/voices/:profileId — delete voice profile
  app.delete('/api/voices/:profileId', async (req, reply) => {
    const { profileId } = req.params as { profileId: string };
    const deleted = await deleteProfile(vpaHome, profileId);
    if (!deleted) {
      return reply.status(404).send({ error: 'Profile not found', code: 'not_found' });
    }
    return { deleted: true };
  });

  // GET /api/projects/:id/scenes/:sceneId/narration — get narration state
  app.get('/api/projects/:id/scenes/:sceneId/narration', async (req, reply) => {
    const { id, sceneId } = req.params as { id: string; sceneId: string };
    const projectPath = await resolveProjectPath(store, id);

    const sb = await loadStoryboard(projectPath);
    if (!sb) return reply.status(404).send({ error: 'No storyboard found', code: 'not_found' });

    const scene = sb.scenes.find((s) => s.id === sceneId);
    if (!scene)
      return reply
        .status(404)
        .send({ error: `Scene not found: ${sceneId}`, code: 'scene_not_found' });

    const narration = scene.narration;

    // Build chunk info from stored data or split script into paragraphs
    let chunks: Array<{
      index: number;
      text: string;
      hasAudio: boolean;
      audio: string | null;
      durationSec: number | null;
      speaker?: string;
    }> = [];

    if (narration?.script) {
      const paragraphs = splitIntoParagraphs(narration.script);
      chunks = paragraphs.map((text, i) => {
        const stored = narration.chunks?.find((c) => c.index === i);
        return {
          index: i,
          text,
          hasAudio: !!stored?.audio,
          audio: stored?.audio ?? null,
          durationSec: stored?.durationSec ?? null,
          speaker: stored?.speaker ?? undefined,
        };
      });
    }

    return {
      sceneId,
      hasScript: !!narration?.script,
      hasAudio: !!narration?.audio,
      audio: narration?.audio ?? null,
      subtitles: narration?.subtitles ?? null,
      tts: narration?.tts ?? null,
      timingCount: narration?.timings?.length ?? 0,
      chunks,
      mode: narration?.mode ?? 'monologue',
      speakers: narration?.speakers ?? {},
    };
  });

  // POST /api/projects/:id/scenes/:sceneId/narration/generate — generate full narration (legacy)
  app.post('/api/projects/:id/scenes/:sceneId/narration/generate', async (req, reply) => {
    const { id, sceneId } = req.params as { id: string; sceneId: string };
    const { engine, voice, speed } = req.body as {
      engine?: string;
      voice?: string;
      speed?: number;
    };

    if (!engine || !voice) {
      return reply
        .status(400)
        .send({ error: 'engine and voice are required', code: 'invalid_request' });
    }

    const projectPath = await resolveProjectPath(store, id);

    try {
      const result = await generateNarration(
        { projectPath, sceneId, engine, voice, speed },
        tts,
      );
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Narration generation failed';
      if (message.includes('not found') || message.includes('No storyboard')) {
        return reply.status(404).send({ error: message, code: 'not_found' });
      }
      if (message.includes('no script')) {
        return reply
          .status(400)
          .send({ error: message, code: 'missing_script' });
      }
      throw err;
    }
  });

  // POST /api/projects/:id/scenes/:sceneId/narration/generate-chunk — generate one chunk
  app.post('/api/projects/:id/scenes/:sceneId/narration/generate-chunk', async (req, reply) => {
    const { id, sceneId } = req.params as { id: string; sceneId: string };
    const { chunkIndex, text, engine, voice, speed } = req.body as {
      chunkIndex: number;
      text: string;
      engine?: string;
      voice?: string;
      speed?: number;
    };

    if (chunkIndex == null || !text || !engine || !voice) {
      return reply
        .status(400)
        .send({ error: 'chunkIndex, text, engine, and voice are required', code: 'invalid_request' });
    }

    const projectPath = await resolveProjectPath(store, id);

    try {
      const result = await generateChunkNarration(
        { projectPath, sceneId, chunkIndex, text, engine, voice, speed },
        tts,
      );
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Chunk generation failed';
      if (message.includes('not found') || message.includes('No storyboard')) {
        return reply.status(404).send({ error: message, code: 'not_found' });
      }
      throw err;
    }
  });

  // PUT /api/projects/:id/scenes/:sceneId/narration/script — save edited script from narration page
  app.put('/api/projects/:id/scenes/:sceneId/narration/script', async (req, reply) => {
    const { id, sceneId } = req.params as { id: string; sceneId: string };
    const { script } = req.body as { script: string };

    if (!script) {
      return reply.status(400).send({ error: 'script is required', code: 'invalid_request' });
    }

    const projectPath = await resolveProjectPath(store, id);
    const sb = await loadStoryboard(projectPath);
    if (!sb) return reply.status(404).send({ error: 'No storyboard found', code: 'not_found' });

    const scene = sb.scenes.find((s) => s.id === sceneId);
    if (!scene)
      return reply.status(404).send({ error: `Scene not found: ${sceneId}`, code: 'scene_not_found' });

    // Update script, clear chunk audio (text changed so chunks are stale)
    const narration = {
      ...(scene.narration ?? {}),
      script,
      // Keep TTS settings but clear chunk audio data since text changed
      chunks: undefined,
      audio: undefined,
      subtitles: undefined,
      timings: undefined,
    };

    const updated = updateScene(sb, sceneId, { narration: narration as any });
    await saveStoryboard(projectPath, updated);

    return { saved: true, script };
  });

  // PUT /api/projects/:id/scenes/:sceneId/narration/mode — save narration mode + speaker configs
  app.put('/api/projects/:id/scenes/:sceneId/narration/mode', async (req, reply) => {
    const { id, sceneId } = req.params as { id: string; sceneId: string };
    const { mode, speakers } = req.body as {
      mode: 'monologue' | 'dialog';
      speakers?: Record<string, { engine: string; voice: string; speed: number; label?: string }>;
    };

    if (!mode || !['monologue', 'dialog'].includes(mode)) {
      return reply.status(400).send({ error: 'mode must be "monologue" or "dialog"', code: 'invalid_request' });
    }

    const projectPath = await resolveProjectPath(store, id);
    const sb = await loadStoryboard(projectPath);
    if (!sb) return reply.status(404).send({ error: 'No storyboard found', code: 'not_found' });

    const scene = sb.scenes.find((s) => s.id === sceneId);
    if (!scene)
      return reply.status(404).send({ error: `Scene not found: ${sceneId}`, code: 'scene_not_found' });

    const narration = {
      ...(scene.narration ?? { script: '' }),
      mode,
      speakers: speakers ?? scene.narration?.speakers ?? {},
    };

    const updated = updateScene(sb, sceneId, { narration: narration as any });
    await saveStoryboard(projectPath, updated);

    return { saved: true };
  });

  // PUT /api/projects/:id/scenes/:sceneId/narration/speakers — save per-chunk speaker assignments
  app.put('/api/projects/:id/scenes/:sceneId/narration/speakers', async (req, reply) => {
    const { id, sceneId } = req.params as { id: string; sceneId: string };
    const { assignments } = req.body as {
      assignments: Array<{ index: number; speaker: string }>;
    };

    if (!assignments || !Array.isArray(assignments)) {
      return reply.status(400).send({ error: 'assignments array is required', code: 'invalid_request' });
    }

    const projectPath = await resolveProjectPath(store, id);
    const sb = await loadStoryboard(projectPath);
    if (!sb) return reply.status(404).send({ error: 'No storyboard found', code: 'not_found' });

    const scene = sb.scenes.find((s) => s.id === sceneId);
    if (!scene)
      return reply.status(404).send({ error: `Scene not found: ${sceneId}`, code: 'scene_not_found' });

    // Update speaker assignments on existing chunks (or create stub chunks)
    const existingChunks = scene.narration?.chunks ?? [];
    const updatedChunks = [...existingChunks];

    for (const { index, speaker } of assignments) {
      const ci = updatedChunks.findIndex((c) => c.index === index);
      if (ci >= 0) {
        updatedChunks[ci] = { ...updatedChunks[ci]!, speaker };
      } else {
        // Create a stub chunk with speaker assignment (text filled from paragraphs)
        const paragraphs = scene.narration?.script ? splitIntoParagraphs(scene.narration.script) : [];
        updatedChunks.push({
          index,
          text: paragraphs[index] ?? '',
          speaker,
        });
      }
    }
    updatedChunks.sort((a, b) => a.index - b.index);

    const narration = {
      ...(scene.narration ?? { script: '' }),
      chunks: updatedChunks,
    };

    const updated = updateScene(sb, sceneId, { narration: narration as any });
    await saveStoryboard(projectPath, updated);

    return { saved: true };
  });

  // GET /api/projects/:id/scenes/:sceneId/narration/audio — stream full MP3
  app.get('/api/projects/:id/scenes/:sceneId/narration/audio', async (req, reply) => {
    const { id, sceneId } = req.params as { id: string; sceneId: string };
    const projectPath = await resolveProjectPath(store, id);

    const sb = await loadStoryboard(projectPath);
    if (!sb) return reply.status(404).send({ error: 'No storyboard found', code: 'not_found' });

    const scene = sb.scenes.find((s) => s.id === sceneId);
    if (!scene)
      return reply.status(404).send({ error: `Scene not found: ${sceneId}`, code: 'scene_not_found' });

    if (!scene.narration?.audio) {
      return reply
        .status(404)
        .send({ error: 'No audio generated for this scene', code: 'no_audio' });
    }

    const audioPath = join(projectPath, scene.narration.audio);
    try {
      const fileStat = await stat(audioPath);
      reply.header('Content-Type', 'audio/mpeg');
      reply.header('Content-Length', fileStat.size);
      return reply.send(createReadStream(audioPath));
    } catch {
      return reply.status(404).send({ error: 'Audio file not found on disk', code: 'no_audio' });
    }
  });

  // GET /api/projects/:id/scenes/:sceneId/narration/chunk/:chunkIndex/audio — stream chunk audio
  app.get('/api/projects/:id/scenes/:sceneId/narration/chunk/:chunkIndex/audio', async (req, reply) => {
    const { id, sceneId, chunkIndex } = req.params as { id: string; sceneId: string; chunkIndex: string };
    const projectPath = await resolveProjectPath(store, id);

    const sb = await loadStoryboard(projectPath);
    if (!sb) return reply.status(404).send({ error: 'No storyboard found', code: 'not_found' });

    const scene = sb.scenes.find((s) => s.id === sceneId);
    if (!scene)
      return reply.status(404).send({ error: `Scene not found: ${sceneId}`, code: 'scene_not_found' });

    const chunk = scene.narration?.chunks?.find((c) => c.index === Number(chunkIndex));
    if (!chunk?.audio) {
      return reply.status(404).send({ error: 'No audio for this chunk', code: 'no_audio' });
    }

    const audioPath = join(projectPath, chunk.audio);
    try {
      const fileStat = await stat(audioPath);
      // Detect content type from file extension
      const contentType = chunk.audio.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg';
      reply.header('Content-Type', contentType);
      reply.header('Content-Length', fileStat.size);
      return reply.send(createReadStream(audioPath));
    } catch {
      return reply.status(404).send({ error: 'Audio file not found on disk', code: 'no_audio' });
    }
  });
}
