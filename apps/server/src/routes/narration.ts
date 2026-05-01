import type { FastifyInstance } from 'fastify';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProjectStore } from '../services/project/store.js';
import type { TtsService } from '../services/tts/index.js';
import { loadStoryboard } from '../services/storyboard/index.js';
import { generateNarration } from '../services/narration/index.js';
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
    return {
      sceneId,
      hasScript: !!narration?.script,
      hasAudio: !!narration?.audio,
      audio: narration?.audio ?? null,
      subtitles: narration?.subtitles ?? null,
      tts: narration?.tts ?? null,
      timingCount: narration?.timings?.length ?? 0,
    };
  });

  // POST /api/projects/:id/scenes/:sceneId/narration/generate — generate narration
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

  // GET /api/projects/:id/scenes/:sceneId/narration/audio — stream MP3
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
}
