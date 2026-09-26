import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { mapTranscriptToComposition } from '@vpa/shared';
import type { ProjectStore } from '../services/project/store.js';
import type { ModelRouter } from '../services/llm/model-router.js';
import { ModelRoutingError } from '../services/llm/model-router.js';
import { loadStoryboard } from '../services/storyboard/index.js';
import { AssetStore } from '../services/assets/store.js';
import { RevisionStore } from '../services/revisions/store.js';
import { resolveSafeProjectPath } from '../services/project/safe-path.js';
import { SourceEvidenceError, SourceEvidenceService } from '../services/source-evidence/index.js';

const ArtifactBody = z.object({
  kind: z.enum(['frame', 'contact-sheet', 'excerpt']),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative().optional(),
  density: z.number().int().min(4).max(16).optional(),
}).strict();

export async function registerSourceEvidenceRoutes(app: FastifyInstance, deps: { store: ProjectStore; router: ModelRouter; evidence: SourceEvidenceService }): Promise<void> {
  const context = async (projectId: string, sceneId: string) => {
    const project = await deps.store.readProject(projectId);
    const storyboard = await loadStoryboard(project.path);
    const scene = storyboard?.scenes.find((candidate) => candidate.id === sceneId);
    if (!storyboard || !scene) throw Object.assign(new Error('Scene not found.'), { statusCode: 404 });
    const assets = new AssetStore(project.path);
    const assetId = scene.composition?.clips[0]?.source_asset_id ?? scene.recording?.asset_id;
    const asset = assetId ? await assets.get(assetId) : undefined;
    if (!asset) throw Object.assign(new Error('Assign an immutable source before analyzing speech.'), { statusCode: 400 });
    return { project, storyboard, scene, asset, sourcePath: await resolveSafeProjectPath(project.path, asset.source) };
  };

  app.get<{ Params: { id: string; sceneId: string } }>('/api/projects/:id/scenes/:sceneId/evidence', async (request, reply) => {
    try {
      const { scene } = await context(request.params.id, request.params.sceneId);
      return {
        transcript: scene.transcript ?? null,
        mappedWords: scene.transcript && scene.composition ? mapTranscriptToComposition(scene.transcript, scene.composition) : scene.transcript?.words ?? [],
        evidence: scene.evidence ?? [],
      };
    } catch (error) {
      return reply.status((error as { statusCode?: number }).statusCode ?? 500).send({ error: error instanceof Error ? error.message : 'Evidence unavailable.', code: 'evidence_unavailable' });
    }
  });

  app.post<{ Params: { id: string; sceneId: string } }>('/api/projects/:id/scenes/:sceneId/evidence/transcribe', async (request, reply) => {
    try {
      const value = await context(request.params.id, request.params.sceneId);
      const model = await deps.router.resolveVideo(value.project);
      let transcript = await deps.evidence.ensureTranscript({ projectRoot: value.project.path, asset: value.asset, sourcePath: value.sourcePath, model, scene: value.scene });
      transcript = await deps.evidence.writeMappedSrt(value.project.path, value.scene, transcript);
      const revisions = new RevisionStore(value.project.path);
      await revisions.execute({ expectedRevision: await revisions.currentRevision(), idempotencyKey: `transcript-${randomUUID()}`, targetState: 'accepted', commands: [{ type: 'transcript.set', sceneId: value.scene.id, transcript }] });
      return { transcript, mappedWords: value.scene.composition ? mapTranscriptToComposition(transcript, value.scene.composition) : transcript.words, reused: transcript.created_at !== new Date().toISOString() };
    } catch (error) {
      if (error instanceof ModelRoutingError) return reply.status(error.statusCode).send({ error: error.message, code: error.code, role: error.role, scope: error.scope });
      const status = (error as { statusCode?: number }).statusCode ?? (error instanceof SourceEvidenceError ? 422 : 500);
      return reply.status(status).send({ error: error instanceof Error ? error.message : 'Transcription failed.', code: error instanceof SourceEvidenceError ? error.code : 'source_evidence_failed' });
    }
  });

  app.patch<{ Params: { id: string; sceneId: string; wordId: string }; Body: { text?: string } }>('/api/projects/:id/scenes/:sceneId/evidence/words/:wordId', async (request, reply) => {
    try {
      const text = z.string().trim().min(1).max(120).parse(request.body?.text);
      const value = await context(request.params.id, request.params.sceneId);
      const revisions = new RevisionStore(value.project.path);
      await revisions.execute({ expectedRevision: await revisions.currentRevision(), idempotencyKey: `word-fix-${randomUUID()}`, targetState: 'accepted', commands: [{ type: 'transcript.word.correct', sceneId: value.scene.id, wordId: request.params.wordId, text }] });
      const updated = (await loadStoryboard(value.project.path))!.scenes.find((scene) => scene.id === value.scene.id)!;
      const transcript = await deps.evidence.writeMappedSrt(value.project.path, updated, updated.transcript!);
      await revisions.execute({ expectedRevision: await revisions.currentRevision(), idempotencyKey: `word-srt-${randomUUID()}`, targetState: 'accepted', commands: [{ type: 'transcript.set', sceneId: updated.id, transcript }] });
      return { transcript };
    } catch (error) {
      return reply.status((error as { statusCode?: number }).statusCode ?? 400).send({ error: error instanceof Error ? error.message : 'Correction failed.', code: 'invalid_correction' });
    }
  });

  app.post<{ Params: { id: string; sceneId: string }; Body: unknown }>('/api/projects/:id/scenes/:sceneId/evidence/artifacts', async (request, reply) => {
    try {
      const body = ArtifactBody.parse(request.body);
      const value = await context(request.params.id, request.params.sceneId);
      const item = await deps.evidence.createArtifact({ projectRoot: value.project.path, asset: value.asset, sourcePath: value.sourcePath, ...body });
      const revisions = new RevisionStore(value.project.path);
      await revisions.execute({ expectedRevision: await revisions.currentRevision(), idempotencyKey: `evidence-${randomUUID()}`, targetState: 'accepted', commands: [{ type: 'scene.put', scene: { ...value.scene, evidence: [...(value.scene.evidence ?? []).filter((entry) => entry.id !== item.id), item] } }] });
      return item;
    } catch (error) {
      return reply.status(error instanceof SourceEvidenceError ? 422 : 400).send({ error: error instanceof Error ? error.message : 'Evidence creation failed.', code: 'source_evidence_failed' });
    }
  });

  app.get<{ Params: { id: string; sceneId: string; evidenceId: string } }>('/api/projects/:id/scenes/:sceneId/evidence/artifacts/:evidenceId', async (request, reply) => {
    const value = await context(request.params.id, request.params.sceneId);
    const item = value.scene.evidence?.find((entry) => entry.id === request.params.evidenceId);
    if (!item) return reply.status(404).send({ error: 'Evidence item not found.', code: 'not_found' });
    const file = await resolveSafeProjectPath(value.project.path, item.path);
    const info = await stat(file).catch(() => null);
    if (!info) return reply.status(404).send({ error: 'Evidence file is missing.', code: 'not_found' });
    reply.header('Content-Type', item.kind === 'excerpt' ? 'video/mp4' : 'image/jpeg');
    return reply.send(createReadStream(file));
  });
}
