import type { FastifyInstance } from 'fastify';
import { createReadStream } from 'node:fs';
import { stat, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProjectStore } from '../services/project/store.js';
import type { TtsService } from '../services/tts/index.js';
import type { LlmClient } from '../services/llm/index.js';
import { loadPrompt } from '../services/llm/prompts.js';
import { loadStoryboard, saveStoryboard, updateScene } from '../services/storyboard/index.js';
import { generateNarration, generateChunkNarration, splitIntoParagraphs, splitDialogIntoChunks } from '../services/narration/index.js';
import {
  listProfiles,
  saveProfile,
  deleteProfile,
} from '../services/voice-profile/index.js';
import type { VoiceProfile } from '../services/voice-profile/index.js';
import { VoiceCloneStore } from '../services/voice-clone/store.js';

interface Deps {
  store: ProjectStore;
  tts: TtsService;
  llm: LlmClient;
  vpaHome: string;
}

async function resolveProjectPath(store: ProjectStore, projectId: string): Promise<string> {
  const tracker = await store.readTracker();
  const entry = tracker.projects.find((p) => p.id === projectId);
  if (!entry) throw { statusCode: 404, message: `Project not found: ${projectId}` };
  return entry.path;
}

// Voice clone reading script + instructions moved to routes/voice-clone.ts.

export async function registerNarrationRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { store, tts, llm, vpaHome } = deps;

  const voiceCloneStore = new VoiceCloneStore({ vpaHome });

  // GET /api/tts/engines — list available TTS engines, augmented with cloned voices
  app.get('/api/tts/engines', async () => {
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
      if (engine.id === 'fish') {
        // Fish gets one entry per local clone: voice id is the slug,
        // provider reads ~/.vpa/voice-clones/<slug>/audio.wav directly.
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
      const isDialog = (narration.mode ?? 'monologue') === 'dialog';
      const paragraphs = isDialog
        ? splitDialogIntoChunks(narration.script)
        : splitIntoParagraphs(narration.script);
      chunks = paragraphs.map((text, i) => {
        const stored = narration.chunks?.find((c) => c.index === i);
        return {
          index: i,
          text,
          hasAudio: !!stored?.audio,
          audio: stored?.audio ?? null,
          durationSec: stored?.durationSec ?? null,
          speaker: stored?.speaker
            ?? (isDialog ? (text.match(/^\[Speaker ([A-Z])\]/)?.[1] ?? undefined) : undefined),
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

  // PUT /api/projects/:id/scenes/:sceneId/narration/script — save edited script
  // Accepts optional `slot` param: 'monologue' | 'dialog' to save to a specific version.
  // If omitted, falls back to current mode (legacy behavior).
  app.put('/api/projects/:id/scenes/:sceneId/narration/script', async (req, reply) => {
    const { id, sceneId } = req.params as { id: string; sceneId: string };
    const { script, slot } = req.body as { script: string; slot?: 'monologue' | 'dialog' };

    if (!script) {
      return reply.status(400).send({ error: 'script is required', code: 'invalid_request' });
    }

    const projectPath = await resolveProjectPath(store, id);
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
          : splitDialogIntoChunks(prev.dialogScript).map((text, i) => {
              const speakerMatch = text.match(/^\[Speaker\s+(A|B)\]/i);
              return {
                index: i,
                text,
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

  // POST /api/projects/:id/scenes/:sceneId/narration/convert-dialog — LLM converts monologue to dialog
  app.post('/api/projects/:id/scenes/:sceneId/narration/convert-dialog', async (req, reply) => {
    const { id, sceneId } = req.params as { id: string; sceneId: string };
    const projectPath = await resolveProjectPath(store, id);

    const sb = await loadStoryboard(projectPath);
    if (!sb) return reply.status(404).send({ error: 'No storyboard found', code: 'not_found' });

    const scene = sb.scenes.find((s) => s.id === sceneId);
    if (!scene)
      return reply.status(404).send({ error: `Scene not found: ${sceneId}`, code: 'scene_not_found' });

    // Always convert from the monologue version, not the active script
    const script = scene.narration?.monologueScript ?? scene.narration?.script;
    if (!script)
      return reply.status(400).send({ error: 'No monologue script to convert', code: 'missing_script' });

    // Load the dialog conversion prompt
    const wsRoot = join(import.meta.dirname, '../../../../..');
    let systemPrompt: string;
    try {
      systemPrompt = await loadPrompt(wsRoot, 'narration-convert-dialog');
    } catch {
      // Inline fallback if prompt file is missing
      systemPrompt = 'Convert the following narration monologue into a natural two-person dialog between Speaker A and Speaker B. Prefix each paragraph with [Speaker A] or [Speaker B]. Keep total word count similar. Return only the script.';
    }

    try {
      const result = await llm.complete({
        systemPrompt,
        userPrompt: `Convert this narration script to dialog:\n\n${script}`,
        temperature: 0.7,
      });

      const dialogScript = result.text.trim();

      // Parse speaker assignments from the generated dialog
      const paragraphs = splitDialogIntoChunks(dialogScript);
      const chunks = paragraphs.map((text, i) => {
        const speakerMatch = text.match(/^\[Speaker\s+(A|B)\]/i);
        return {
          index: i,
          text: speakerMatch ? text.replace(/^\[Speaker\s+(?:A|B)\]\s*/i, '') : text,
          speaker: speakerMatch ? speakerMatch[1]!.toUpperCase() : (i % 2 === 0 ? 'A' : 'B'),
        };
      });

      // Save both versions: dialog as active + backup, monologue preserved
      const narration = {
        ...(scene.narration ?? {}),
        script: dialogScript,
        dialogScript,                                                 // persist dialog version
        monologueScript: scene.narration?.monologueScript ?? script,  // preserve monologue
        dialogDirty: false,                                           // legacy field, kept for schema compat
        mode: 'dialog' as const,
        chunks: chunks.map((c) => ({ index: c.index, text: c.text, speaker: c.speaker })),
        // Clear stale audio
        audio: undefined,
        subtitles: undefined,
        timings: undefined,
      };

      const updated = updateScene(sb, sceneId, { narration: narration as any });
      await saveStoryboard(projectPath, updated);

      return { script: dialogScript, chunks };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Dialog conversion failed';
      return reply.status(500).send({ error: message, code: 'llm_error' });
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
