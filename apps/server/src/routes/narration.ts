import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { createReadStream } from 'node:fs';
import { stat, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProjectStore } from '../services/project/store.js';
import type { TtsService } from '../services/tts/index.js';
import { ModelRoutingError, type ModelRouter } from '../services/llm/model-router.js';
import type { Expressiveness } from '@vpa/shared';
import { loadStoryboard, saveStoryboard, updateScene } from '../services/storyboard/index.js';
import { batchRequiresWriting, generateNarration, generateChunkNarration, generateAllChunks, inspectNarrationBatch, splitScriptIntoChunks, type ChunkSelector } from '../services/narration/index.js';
import { generateProjectNarration } from '../services/narration/project-generation.js';
import { jobQueue } from '../lib/job-queue.js';
import {
  listProfiles,
  saveProfile,
  deleteProfile,
} from '../services/voice-profile/index.js';
import type { VoiceProfile } from '../services/voice-profile/index.js';
import { VoiceCloneStore } from '../services/voice-clone/store.js';
import { sourceDocsNeedSummarization } from '../services/project-source-docs/context.js';

interface Deps {
  store: ProjectStore;
  tts: TtsService;
  router: ModelRouter;
  workspaceRoot: string;
  vpaHome: string;
}

const ProjectNarrationRequestSchema = z.object({
  engine: z.string().min(1).max(100),
  voice: z.string().min(1).max(200),
  speed: z.number().finite().min(0.5).max(2).default(1),
  expressiveness: z.enum(['light', 'medium', 'heavy']).default('medium'),
  overwrite: z.boolean().default(false),
}).strict();

/** Coerce a request value to a valid emotiveness level, else undefined
 *  (the narration service then defaults to 'medium'). */
function coerceExpressiveness(v: unknown): Expressiveness | undefined {
  return v === 'light' || v === 'medium' || v === 'heavy' ? v : undefined;
}

async function resolveProjectPath(store: ProjectStore, projectId: string): Promise<string> {
  const tracker = await store.readTracker();
  const entry = tracker.projects.find((p) => p.id === projectId);
  if (!entry) throw { statusCode: 404, message: `Project not found: ${projectId}` };
  return entry.path;
}

async function resolveProject(store: ProjectStore, projectId: string) {
  try {
    return await store.readProject(projectId);
  } catch {
    throw { statusCode: 404, message: `Project not found: ${projectId}` };
  }
}

async function batchUsesXai(
  projectPath: string,
  sceneId: string,
  input: { engine: string; voice: string; speed?: number; selector?: ChunkSelector },
): Promise<boolean> {
  const storyboard = await loadStoryboard(projectPath);
  const scene = storyboard?.scenes.find((candidate) => candidate.id === sceneId);
  return scene ? batchRequiresWriting(scene, input) : false;
}

// Voice clone reading script + instructions moved to routes/voice-clone.ts.

export async function registerNarrationRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { store, tts, router, workspaceRoot, vpaHome } = deps;

  const voiceCloneStore = new VoiceCloneStore({ vpaHome });
  const activeNarrationRequests = new Set<string>();
  const activeNarrationJobs = (projectId: string) => jobQueue
    .list({ activeOnly: true, projectId })
    .filter((job) => job.type === 'narration-generate-project' || job.type === 'narration-generate-all');
  const hasActiveNarrationWork = (projectId: string) =>
    activeNarrationRequests.has(projectId) || activeNarrationJobs(projectId).length > 0;
  const conflict = (reply: FastifyReply) => reply.status(409).send({
    error: 'Narration generation is already running for this project',
    code: 'narration_job_active',
  });

  // While a project run owns narration, reject every other narration mutation
  // (script, gaps, speakers, and scene generation included). Reads remain
  // available, so the scene list can stay mounted and refresh safely.
  app.addHook('preHandler', async (req, reply) => {
    const route = req.routeOptions.url;
    const id = (req.params as { id?: string } | null)?.id;
    const mutating = req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE';
    if (
      id
      && mutating
      && route?.includes('/narration')
      && route !== '/api/projects/:id/narration/generate-project'
      && activeNarrationJobs(id).some((job) => job.type === 'narration-generate-project')
    ) {
      return conflict(reply);
    }
  });

  const listAdvertisedEngines = async () => {
    const engines = tts.listEngines();
    let clones: Awaited<ReturnType<VoiceCloneStore['list']>> = [];
    try {
      clones = await voiceCloneStore.list();
    } catch { /* no clones */ }

    return engines.map((engine) => {
      if (engine.id === 'xai') {
        const cloneVoices = clones
          .filter((c) => c.providers.xai?.voice_id)
          .map((c) => ({
            id: c.providers.xai!.voice_id,
            name: `${c.name} (cloned)`,
            description: 'Custom voice cloned via xAI',
          }));
        return { ...engine, voices: [...engine.voices, ...cloneVoices] };
      }
      if (engine.id === 'qwen') {
        // Qwen3-TTS is where local voice cloning lives. Each clone with
        // local audio is exposed as `clone:<slug>`; the provider resolves
        // ~/.vpa/voice-clones/<slug>/{audio.wav,transcript.txt} at synth time.
        const cloneVoices = clones
          .filter((c) => c.hasAudio)
          .map((c) => ({
            id: `clone:${c.id}`,
            name: `${c.name} (cloned)`,
            description: 'Voice clone — uses your local recording',
          }));
        return { ...engine, voices: [...engine.voices, ...cloneVoices] };
      }
      return engine;
    });
  };

  // GET /api/tts/engines — list available TTS engines, augmented with cloned voices
  app.get('/api/tts/engines', async () => {
    return listAdvertisedEngines();
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

  // POST /api/projects/:id/narration/generate-project — generate narration
  // sequentially for every scripted scene. Existing audio is preserved unless
  // overwrite is explicitly true.
  app.post('/api/projects/:id/narration/generate-project', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = ProjectNarrationRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid project narration settings', code: 'invalid_request' });
    }

    const engine = (await listAdvertisedEngines())
      .find((candidate) => candidate.id === parsed.data.engine);
    if (!engine || !engine.voices.some((candidate) => candidate.id === parsed.data.voice)) {
      return reply.status(400).send({ error: 'Unknown narration engine or voice', code: 'invalid_request' });
    }

    if (hasActiveNarrationWork(id)) return conflict(reply);
    activeNarrationRequests.add(id);

    let project;
    try {
      project = await resolveProject(store, id);
    } catch {
      activeNarrationRequests.delete(id);
      return reply.status(404).send({ error: `Project not found: ${id}`, code: 'not_found' });
    }
    let storyboard;
    try {
      storyboard = await loadStoryboard(project.path);
    } catch (error) {
      activeNarrationRequests.delete(id);
      throw error;
    }
    if (!storyboard) {
      activeNarrationRequests.delete(id);
      return reply.status(404).send({ error: 'No storyboard found', code: 'not_found' });
    }

    const scenes = storyboard.scenes.map(({ id: sceneId, name }) => ({ id: sceneId, name }));
    const job = jobQueue.create('narration-generate-project', {
      projectId: id,
      label: 'Project narration',
    });
    activeNarrationRequests.delete(id);
    jobQueue.setStatus(job.id, 'running');
    jobQueue.emit(job.id, 'start', {
      totalScenes: scenes.length,
      engine: parsed.data.engine,
      voice: parsed.data.voice,
      overwrite: parsed.data.overwrite,
    });

    void (async () => {
      let writerPromise: ReturnType<ModelRouter['resolveText']> | undefined;
      try {
        const result = await generateProjectNarration(
          {
            projectPath: project.path,
            scenes,
            ...parsed.data,
          },
          {
            loadStoryboard,
            inspectBatch: inspectNarrationBatch,
            resolveWriter: async () => {
              writerPromise ??= router.resolveText('writing', project);
              return (await writerPromise).client;
            },
            generateScene: (input, writer, onProgress, isCancelled) => generateAllChunks(
              input,
              tts,
              writer,
              workspaceRoot,
              onProgress,
              isCancelled,
            ),
            onProgress: (progress) => jobQueue.emit(job.id, 'progress', progress),
            isCancelled: () => {
              const status = jobQueue.get(job.id)?.status;
              return status === 'cancelling' || status === 'cancelled';
            },
          },
        );
        jobQueue.complete(job.id, result);
      } catch {
        if (jobQueue.get(job.id)?.status === 'cancelling') {
          jobQueue.complete(job.id, {
            totalScenes: scenes.length,
            generatedScenes: 0,
            generatedChunks: 0,
            preservedScenes: 0,
            noScriptScenes: 0,
            removedScenes: 0,
            failedScenes: 0,
            cancelled: true,
            failures: [],
          });
          return;
        }
        jobQueue.fail(job.id, 'Project narration failed. Review narration settings, then try again.');
      }
    })();

    return { jobId: job.id, status: 'running' };
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
      failed?: { reason: string; at: string };
    }> = [];

    if (narration?.script) {
      const isDialog = (narration.mode ?? 'monologue') === 'dialog';
      const derived = splitScriptIntoChunks(narration.script, isDialog);
      chunks = derived.map(({ text, gapSec }, i) => {
        const stored = narration.chunks?.find((c) => c.index === i);
        // Stored gap (a UI edit) wins over the script-derived seed.
        const effGap = stored?.gapSec ?? gapSec;
        return {
          index: i,
          text,
          hasAudio: !!stored?.audio,
          audio: stored?.audio ?? null,
          durationSec: stored?.durationSec ?? null,
          ...(effGap > 0 ? { gapSec: effGap } : {}),
          speaker: stored?.speaker
            ?? (isDialog ? (text.match(/^\[Speaker ([A-Z])\]/)?.[1] ?? undefined) : undefined),
          ...(stored?.failed ? { failed: stored.failed } : {}),
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
      monologueScript: narration?.monologueScript ?? null,
      dialogScript: narration?.dialogScript ?? null,
      dialogDirty: narration?.dialogDirty ?? false,
      hasPreviousMonologue: !!(narration as any)?.previousMonologueScript,
      hasPreviousDialog: !!(narration as any)?.previousDialogScript,
    };
  });

  // POST /api/projects/:id/scenes/:sceneId/narration/generate — generate full narration (legacy)
  app.post('/api/projects/:id/scenes/:sceneId/narration/generate', async (req, reply) => {
    const { id, sceneId } = req.params as { id: string; sceneId: string };
    const body = req.body as {
      engine?: string;
      voice?: string;
      speed?: number;
      expressiveness?: unknown;
    };
    const { engine, voice, speed } = body;
    const expressiveness = coerceExpressiveness(body.expressiveness);

    if (!engine || !voice) {
      return reply
        .status(400)
        .send({ error: 'engine and voice are required', code: 'invalid_request' });
    }

    const project = await resolveProject(store, id);
    const projectPath = project.path;
    if (hasActiveNarrationWork(id)) return conflict(reply);
    activeNarrationRequests.add(id);

    try {
      const writer = engine === 'xai'
        ? await router.resolveText('writing', project)
        : undefined;
      const result = await generateNarration(
        { projectPath, sceneId, engine, voice, speed, expressiveness },
        tts,
        writer?.client,
        workspaceRoot,
      );
      return result;
    } catch (err) {
      if (err instanceof ModelRoutingError) {
        return reply.status(err.statusCode).send({ error: err.message, code: err.code, role: err.role });
      }
      const message = err instanceof Error ? err.message : 'Narration generation failed';
      if (message.includes('not found') || message.includes('No storyboard')) {
        return reply.status(404).send({ error: message, code: 'not_found' });
      }
      if (message.includes('no script')) {
        return reply
          .status(400)
          .send({ error: message, code: 'missing_script' });
      }
      req.log.error({ projectId: id, sceneId, errorName: 'NarrationGenerationError' }, 'Narration generation failed');
      return reply.status(500).send({
        error: 'Narration generation failed. Your existing narration was not changed.',
        code: 'narration_generation_failed',
      });
    } finally {
      activeNarrationRequests.delete(id);
    }
  });

  // POST /api/projects/:id/scenes/:sceneId/narration/generate-chunk — generate one chunk
  app.post('/api/projects/:id/scenes/:sceneId/narration/generate-chunk', async (req, reply) => {
    const { id, sceneId } = req.params as { id: string; sceneId: string };
    const body = req.body as {
      chunkIndex: number;
      text: string;
      engine?: string;
      voice?: string;
      speed?: number;
      expressiveness?: unknown;
    };
    const { chunkIndex, text, engine, voice, speed } = body;
    const expressiveness = coerceExpressiveness(body.expressiveness);

    if (chunkIndex == null || !text || !engine || !voice) {
      return reply
        .status(400)
        .send({ error: 'chunkIndex, text, engine, and voice are required', code: 'invalid_request' });
    }

    const project = await resolveProject(store, id);
    const projectPath = project.path;
    if (hasActiveNarrationWork(id)) return conflict(reply);
    activeNarrationRequests.add(id);

    try {
      const writer = engine === 'xai'
        ? await router.resolveText('writing', project)
        : undefined;
      const result = await generateChunkNarration(
        { projectPath, sceneId, chunkIndex, text, engine, voice, speed, expressiveness },
        tts,
        writer?.client,
        workspaceRoot,
      );
      return result;
    } catch (err) {
      if (err instanceof ModelRoutingError) {
        return reply.status(err.statusCode).send({ error: err.message, code: err.code, role: err.role });
      }
      const message = err instanceof Error ? err.message : 'Chunk generation failed';
      if (message.includes('not found') || message.includes('No storyboard')) {
        return reply.status(404).send({ error: message, code: 'not_found' });
      }
      req.log.error({ projectId: id, sceneId, errorName: 'ChunkGenerationError' }, 'Narration chunk generation failed');
      return reply.status(500).send({
        error: 'Narration chunk generation failed. Your existing narration was not changed.',
        code: 'narration_chunk_generation_failed',
      });
    } finally {
      activeNarrationRequests.delete(id);
    }
  });

  // PUT /api/projects/:id/scenes/:sceneId/narration/chunks/:index/gap — set the
  // trailing silence (seconds) after a chunk. Applied at concat time, so this
  // does NOT regenerate audio. gapSec 0 clears the pause.
  app.put('/api/projects/:id/scenes/:sceneId/narration/chunks/:index/gap', async (req, reply) => {
    const { id, sceneId, index } = req.params as { id: string; sceneId: string; index: string };
    const body = (req.body ?? {}) as { gapSec?: unknown };
    const idx = Number(index);
    const gap = typeof body.gapSec === 'number' ? body.gapSec : NaN;
    if (!Number.isInteger(idx) || idx < 0) {
      return reply.status(400).send({ error: 'invalid chunk index', code: 'invalid_request' });
    }
    if (!Number.isFinite(gap) || gap < 0 || gap > 10) {
      return reply.status(400).send({ error: 'gapSec must be between 0 and 10', code: 'invalid_request' });
    }
    const projectPath = await resolveProjectPath(store, id);
    const sb = await loadStoryboard(projectPath);
    if (!sb) return reply.status(404).send({ error: 'No storyboard found', code: 'not_found' });
    const scene = sb.scenes.find((s) => s.id === sceneId);
    if (!scene) return reply.status(404).send({ error: `Scene not found: ${sceneId}`, code: 'scene_not_found' });
    const chunks = [...(scene.narration?.chunks ?? [])];
    const ci = chunks.findIndex((c) => c.index === idx);
    if (ci >= 0) {
      const nextChunk = { ...chunks[ci]! };
      if (gap > 0) nextChunk.gapSec = gap;
      else delete (nextChunk as { gapSec?: number }).gapSec;
      chunks[ci] = nextChunk;
    } else {
      // Chunk not generated yet — pauses are independent of TTS, so build a
      // stub from the script (matching how markChunkFailed / speaker
      // assignment do). Nothing to store if the gap is 0.
      if (gap > 0) {
        const isDialog = (scene.narration?.mode ?? 'monologue') === 'dialog';
        const derived = scene.narration?.script
          ? splitScriptIntoChunks(scene.narration.script, isDialog)
          : [];
        const stub = derived[idx];
        if (!stub) return reply.status(404).send({ error: `Chunk not found: ${idx}`, code: 'chunk_not_found' });
        const dm = isDialog ? stub.text.match(/^\[Speaker ([A-Z])\]/) : null;
        chunks.push({ index: idx, text: stub.text, gapSec: gap, ...(dm ? { speaker: dm[1] } : {}) });
        chunks.sort((a, b) => a.index - b.index);
      }
    }
    const narration = { ...(scene.narration ?? {}), chunks };
    const updated = updateScene(sb, sceneId, { narration: narration as any });
    await saveStoryboard(projectPath, updated);
    return { sceneId, index: idx, gapSec: gap };
  });

  // POST /api/projects/:id/scenes/:sceneId/narration/generate-all — batch generate
  // chunks as a server-side job. Body: { engine, voice, speed?, selector? }.
  // selector: 'all' (regenerate everything), 'missing' (default — only ones without
  // audio), or 'failed' (only previously-failed chunks).
  // Returns { jobId } immediately; subscribe to /api/jobs/:jobId/stream for progress.
  app.post('/api/projects/:id/scenes/:sceneId/narration/generate-all', async (req, reply) => {
    const { id, sceneId } = req.params as { id: string; sceneId: string };
    const body = (req.body ?? {}) as {
      engine?: string;
      voice?: string;
      speed?: number;
      expressiveness?: unknown;
      selector?: ChunkSelector;
    };
    if (!body.engine || !body.voice) {
      return reply.status(400).send({ error: 'engine and voice are required', code: 'invalid_request' });
    }
    const expressiveness = coerceExpressiveness(body.expressiveness);
    let project;
    try {
      project = await resolveProject(store, id);
    } catch {
      return reply.status(404).send({ error: `Project not found: ${id}`, code: 'not_found' });
    }
    const projectPath = project.path;
    if (hasActiveNarrationWork(id)) return conflict(reply);
    activeNarrationRequests.add(id);
    let writer: Awaited<ReturnType<ModelRouter['resolveText']>> | undefined;
    try {
      if (await batchUsesXai(projectPath, sceneId, {
        engine: body.engine,
        voice: body.voice,
        speed: body.speed,
        selector: body.selector ?? 'missing',
      })) {
        writer = await router.resolveText('writing', project);
      }
    } catch (error) {
      activeNarrationRequests.delete(id);
      if (error instanceof ModelRoutingError) {
        return reply.status(error.statusCode).send({
          error: error.message,
          code: error.code,
          role: error.role,
        });
      }
      throw error;
    }

    const job = jobQueue.create('narration-generate-all', {
      projectId: id,
      label: `TTS: ${sceneId}`,
    });
    activeNarrationRequests.delete(id);
    jobQueue.setStatus(job.id, 'running');
    jobQueue.emit(job.id, 'start', { sceneId, engine: body.engine, voice: body.voice, selector: body.selector ?? 'missing' });

    void (async () => {
      try {
        const result = await generateAllChunks(
          {
            projectPath,
            sceneId,
            engine: body.engine!,
            voice: body.voice!,
            speed: body.speed,
            expressiveness,
            selector: body.selector ?? 'missing',
          },
          tts,
          writer?.client,
          workspaceRoot,
          (progress) => jobQueue.emit(job.id, 'progress', progress),
          () => jobQueue.get(job.id)?.status === 'cancelled',
        );
        // If we were cancelled, the loop already returned without throwing
        const j = jobQueue.get(job.id);
        if (j?.status === 'cancelled') return;
        jobQueue.complete(job.id, result);
      } catch {
        jobQueue.fail(job.id, 'Narration chunk generation failed. Review model and TTS settings, then try again.');
      }
    })();

    return { jobId: job.id, status: 'running' };
  });

  // POST /api/jobs/:jobId/cancel — request cancellation. Long-running jobs that
  // poll their own status (the chunk batch) check this and bail at the next safe
  // boundary. One-shot jobs (e.g. final render) ignore cancellation today.
  app.post('/api/jobs/:jobId/cancel', async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    const j = jobQueue.get(jobId);
    if (!j) return reply.status(404).send({ error: 'Job not found', code: 'not_found' });
    if (j.status === 'completed' || j.status === 'failed') {
      return { cancelled: false, status: j.status };
    }
    if (j.type === 'narration-generate-project') {
      if (j.status !== 'cancelling') {
        jobQueue.setStatus(jobId, 'cancelling');
        jobQueue.emit(jobId, 'cancel-requested', {});
      }
      return { cancelled: true, status: 'cancelling' };
    }
    jobQueue.setStatus(jobId, 'cancelled');
    jobQueue.emit(jobId, 'cancel', {});
    return { cancelled: true };
  });

  // PUT /api/projects/:id/scenes/:sceneId/narration/script — save edited script
  // Accepts optional `slot` param: 'monologue' | 'dialog' to save to a specific version.
  // If omitted, falls back to current mode (legacy behavior).
  app.put('/api/projects/:id/scenes/:sceneId/narration/script', async (req, reply) => {
    const { id, sceneId } = req.params as { id: string; sceneId: string };
    const { script, slot } = req.body as { script: string; slot?: 'monologue' | 'dialog' };

    if (!script) {
      return reply.status(400).send({ error: 'script is required', code: 'invalid_request' });
    }

    const project = await resolveProject(store, id);
    const projectPath = project.path;
    const sb = await loadStoryboard(projectPath);
    if (!sb) return reply.status(404).send({ error: 'No storyboard found', code: 'not_found' });

    const scene = sb.scenes.find((s) => s.id === sceneId);
    if (!scene)
      return reply.status(404).send({ error: `Scene not found: ${sceneId}`, code: 'scene_not_found' });

    // Use explicit slot if provided, otherwise fall back to current mode
    const targetSlot = slot ?? (scene.narration?.mode ?? 'monologue');
    const currentMode = scene.narration?.mode ?? 'monologue';

    // Capture previous version for restore
    const previousScript = targetSlot === 'monologue'
      ? (scene.narration?.monologueScript ?? null)
      : (scene.narration?.dialogScript ?? null);

    // Build narration update — only update the active script if saving to the current mode's slot
    const narration = {
      ...(scene.narration ?? {}),
      // Only swap the active script if this save targets the active mode
      ...(targetSlot === currentMode ? { script } : {}),
      // Clear chunk audio data since text changed (only for the active mode)
      ...(targetSlot === currentMode
        ? { chunks: undefined, audio: undefined, subtitles: undefined, timings: undefined }
        : {}),
      // Persist into the explicit slot — monologue and dialog are independent
      ...(targetSlot === 'monologue'
        ? { monologueScript: script, previousMonologueScript: previousScript }
        : { dialogScript: script, previousDialogScript: previousScript }),
    };

    const updated = updateScene(sb, sceneId, { narration: narration as any });
    await saveStoryboard(projectPath, updated);

    return { saved: true, script, slot: targetSlot, hasPreviousVersion: !!previousScript };
  });

  // POST /api/projects/:id/scenes/:sceneId/narration/restore — restore previous version of a script
  app.post('/api/projects/:id/scenes/:sceneId/narration/restore', async (req, reply) => {
    const { id, sceneId } = req.params as { id: string; sceneId: string };
    const { slot } = req.body as { slot: 'monologue' | 'dialog' };

    if (!slot || !['monologue', 'dialog'].includes(slot)) {
      return reply.status(400).send({ error: 'slot must be "monologue" or "dialog"', code: 'invalid_request' });
    }

    const projectPath = await resolveProjectPath(store, id);
    const sb = await loadStoryboard(projectPath);
    if (!sb) return reply.status(404).send({ error: 'No storyboard found', code: 'not_found' });

    const scene = sb.scenes.find((s) => s.id === sceneId);
    if (!scene)
      return reply.status(404).send({ error: `Scene not found: ${sceneId}`, code: 'scene_not_found' });

    const prevField = slot === 'monologue' ? 'previousMonologueScript' : 'previousDialogScript';
    const previousScript = (scene.narration as any)?.[prevField];
    if (!previousScript) {
      return reply.status(404).send({ error: 'No previous version to restore', code: 'no_previous_version' });
    }

    const currentMode = scene.narration?.mode ?? 'monologue';
    const currentScript = slot === 'monologue'
      ? scene.narration?.monologueScript
      : scene.narration?.dialogScript;

    // Swap: current becomes previous, previous becomes current
    const narration = {
      ...(scene.narration ?? {}),
      ...(slot === currentMode
        ? { script: previousScript, chunks: undefined, audio: undefined, subtitles: undefined, timings: undefined }
        : {}),
      ...(slot === 'monologue'
        ? { monologueScript: previousScript, previousMonologueScript: currentScript }
        : { dialogScript: previousScript, previousDialogScript: currentScript }),
    };

    const updated = updateScene(sb, sceneId, { narration: narration as any });
    await saveStoryboard(projectPath, updated);

    return { restored: true, script: previousScript, slot };
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

    const prev = scene.narration ?? { script: '' };
    const prevAny = prev as any;
    const prevMode = prev.mode ?? 'monologue';

    // ── Script swapping logic ────────────────────────────
    let scriptUpdates: Record<string, unknown> = {};

    // Snapshot the chunks of the OUTGOING mode so audio survives toggling.
    // The outgoing mode's chunks live in `prev.chunks` (active set).
    const outgoingChunks = prev.chunks ?? [];
    const outgoingChunksKey = prevMode === 'monologue' ? 'monologueChunks' : 'dialogChunks';
    const incomingChunksKey = mode === 'monologue' ? 'monologueChunks' : 'dialogChunks';

    if (mode === 'monologue' && prevMode === 'dialog') {
      // Switching TO monologue — save current script as dialogScript, restore monologue.
      // Save the outgoing dialog chunks under dialogChunks so we can restore them
      // if the user switches back to dialog. Restore monologue chunks if any exist.
      const monoScript = prev.monologueScript ?? prev.script;
      scriptUpdates = {
        script: monoScript,
        dialogScript: prev.script,           // preserve dialog version
        monologueScript: monoScript,
        // Snapshot outgoing dialog chunks for later restore
        [outgoingChunksKey]: outgoingChunks,
        // Restore incoming monologue chunks (or empty if none recorded yet)
        chunks: prevAny[incomingChunksKey] ?? [],
        // Audio/subtitles/timings on the legacy single-track narration are mode-agnostic
        // — leave them alone so we don't drop the user's full-narration export.
      };
    } else if (mode === 'dialog' && prevMode === 'monologue') {
      // Switching TO dialog — if dialog exists, swap it in
      if (prev.dialogScript) {
        // Restore stored dialog chunks if we have them; otherwise rebuild metadata
        // from the dialog script (audio paths come back when user generates).
        const restored = (prevAny.dialogChunks as typeof prev.chunks | undefined) ?? null;
        const dialogChunks = restored && restored.length > 0
          ? restored
          : splitScriptIntoChunks(prev.dialogScript, true).map(({ text, gapSec }, i) => {
              const speakerMatch = text.match(/^\[Speaker\s+(A|B)\]/i);
              return {
                index: i,
                text,
                ...(gapSec > 0 ? { gapSec } : {}),
                speaker: speakerMatch ? speakerMatch[1]!.toUpperCase() : (i % 2 === 0 ? 'A' : 'B'),
              };
            });
        scriptUpdates = {
          script: prev.dialogScript,
          monologueScript: prev.monologueScript ?? prev.script,
          // Snapshot outgoing monologue chunks
          [outgoingChunksKey]: outgoingChunks,
          chunks: dialogChunks,
        };
      } else {
        // No dialog version — frontend must call convert-dialog
        // Snapshot outgoing chunks anyway so they survive
        scriptUpdates = {
          monologueScript: prev.monologueScript ?? prev.script,
          [outgoingChunksKey]: outgoingChunks,
        };
      }
    }

    const narration = {
      ...prev,
      mode,
      speakers: speakers ?? prev.speakers ?? {},
      ...scriptUpdates,
    };

    const updated = updateScene(sb, sceneId, { narration: narration as any });
    await saveStoryboard(projectPath, updated);

    // Tell the frontend whether conversion is needed (only when no dialog exists at all)
    const needsConversion = mode === 'dialog' && !prev.dialogScript;
    return {
      saved: true,
      needsConversion,
      script: narration.script,
    };
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
        // Create a stub chunk with speaker assignment (text filled from the
        // pause-aware split so the index matches the generation path).
        const derived = scene.narration?.script
          ? splitScriptIntoChunks(scene.narration.script, true)
          : [];
        updatedChunks.push({
          index,
          text: derived[index]?.text ?? '',
          ...(derived[index]?.gapSec ? { gapSec: derived[index]!.gapSec } : {}),
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

  // POST /api/projects/:id/scenes/:sceneId/narration/convert-dialog — LLM converts monologue to dialog
  app.post('/api/projects/:id/scenes/:sceneId/narration/convert-dialog', async (req, reply) => {
    const { id, sceneId } = req.params as { id: string; sceneId: string };
    const project = await resolveProject(store, id);
    const projectPath = project.path;

    const sb = await loadStoryboard(projectPath);
    if (!sb) return reply.status(404).send({ error: 'No storyboard found', code: 'not_found' });

    const scene = sb.scenes.find((s) => s.id === sceneId);
    if (!scene)
      return reply.status(404).send({ error: `Scene not found: ${sceneId}`, code: 'scene_not_found' });

    // Always convert from the monologue version, not the active script
    const script = scene.narration?.monologueScript ?? scene.narration?.script;
    if (!script)
      return reply.status(400).send({ error: 'No monologue script to convert', code: 'missing_script' });

    const wsRoot = join(import.meta.dirname, '../../../../..');
    try {
      const needsGeneral = await sourceDocsNeedSummarization(project.path);
      const writer = await router.resolveText('writing', project);
      const general = needsGeneral
        ? await router.resolveText('general', project)
        : undefined;
      const { convertToDialog } = await import('../services/script/convert-to-dialog.js');
      const { dialogScript, chunks } = await convertToDialog(
        script,
        writer.client,
        wsRoot,
        projectPath,
        general?.client,
      );

      // Explicit user-triggered conversion: flip mode to 'dialog', persist
      // both versions, clear stale full-narration audio. (The script-generate
      // path uses the same converter but doesn't flip mode — that's the only
      // behavioral difference.)
      const narration = {
        ...(scene.narration ?? {}),
        script: dialogScript,
        dialogScript,
        monologueScript: scene.narration?.monologueScript ?? script,
        dialogDirty: false,
        mode: 'dialog' as const,
        chunks: chunks.map((c) => ({ index: c.index, text: c.text, speaker: c.speaker })),
        audio: undefined,
        subtitles: undefined,
        timings: undefined,
      };

      const updated = updateScene(sb, sceneId, { narration: narration as any });
      await saveStoryboard(projectPath, updated);

      return { script: dialogScript, chunks };
    } catch (error) {
      if (error instanceof ModelRoutingError) {
        return reply.status(error.statusCode).send({
          error: error.message,
          code: error.code,
          role: error.role,
        });
      }
      req.log.error({ projectId: id, sceneId, errorName: 'DialogConversionError' }, 'Dialog conversion failed');
      return reply.status(500).send({
        error: 'Dialog conversion failed. Your existing narration was not changed.',
        code: 'dialog_conversion_failed',
      });
    }
  });

  // Voice clone endpoints moved to routes/voice-clone.ts (per-voice directory layout
  // with provider registrations). Old flat-file endpoints removed.

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
