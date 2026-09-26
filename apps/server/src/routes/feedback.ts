import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { NormalizedRectSchema } from '@vpa/shared';
import type { ProjectStore } from '../services/project/store.js';
import { RevisionError, RevisionStore } from '../services/revisions/store.js';

const AddBody = z.object({ sceneId: z.string(), clipInstanceId: z.string(), sourceAssetId: z.string(), sourceInMs: z.number().int().nonnegative(), sourceOutMs: z.number().int().positive(), rect: NormalizedRectSchema.optional(), text: z.string().trim().min(1).max(4_000) }).strict();
const ActionBody = z.object({ actor: z.string().min(1).max(200).optional(), resolvingRevision: z.number().int().nonnegative().optional(), resolution: z.string().trim().min(1).max(4_000).optional(), failure: z.string().trim().min(1).max(1_000).optional() }).strict();

export async function registerFeedbackRoutes(app: FastifyInstance, deps: { store: ProjectStore }): Promise<void> {
  const revisions = async (id: string) => new RevisionStore((await deps.store.readProject(id)).path);
  app.get<{ Params: { id: string } }>('/api/projects/:id/feedback', async (request) => {
    const store = await revisions(request.params.id);
    const current = await store.readRevision(await store.currentRevision());
    return { revision: await store.currentRevision(), notes: current.storyboard?.feedback_notes ?? [] };
  });
  app.post<{ Params: { id: string }; Body: unknown }>('/api/projects/:id/feedback', async (request, reply) => {
    try {
      const body = AddBody.parse(request.body);
      const store = await revisions(request.params.id);
      const current = await store.currentRevision();
      const snapshot = await store.readRevision(current);
      const clip = snapshot.storyboard?.scenes.find((scene) => scene.id === body.sceneId)?.composition?.clips.find((candidate) => candidate.id === body.clipInstanceId && candidate.source_asset_id === body.sourceAssetId);
      if (!clip || body.sourceInMs < clip.source_in_ms || body.sourceOutMs > clip.source_out_ms || body.sourceOutMs <= body.sourceInMs) {
        return reply.status(400).send({ error: 'Feedback must reference an existing clip and a source range inside that clip.', code: 'invalid_anchor' });
      }
      const note = { id: `note_${randomUUID()}`, created_at: new Date().toISOString(), created_revision: current, scene_id: body.sceneId, clip_instance_id: body.clipInstanceId, source_asset_id: body.sourceAssetId, source_in_ms: body.sourceInMs, source_out_ms: body.sourceOutMs, rect: body.rect, text: body.text, status: 'pending' as const };
      const result = await store.execute({ expectedRevision: current, idempotencyKey: `feedback-add-${randomUUID()}`, targetState: 'accepted', commands: [{ type: 'feedback.add', note }] });
      return reply.status(201).send({ note, result });
    } catch (error) { return reply.status(error instanceof RevisionError ? 409 : 400).send({ error: error instanceof Error ? error.message : 'Feedback failed.', code: 'feedback_failed' }); }
  });
  app.post<{ Params: { id: string; noteId: string; action: string }; Body: unknown }>('/api/projects/:id/feedback/:noteId/:action', async (request, reply) => {
    try {
      const body = ActionBody.parse(request.body ?? {});
      const store = await revisions(request.params.id);
      const current = await store.currentRevision();
      const command = request.params.action === 'claim'
        ? { type: 'feedback.claim' as const, noteId: request.params.noteId, actor: body.actor ?? 'codex', claimedAt: new Date().toISOString() }
        : request.params.action === 'resolve'
          ? { type: 'feedback.resolve' as const, noteId: request.params.noteId, resolvingRevision: body.resolvingRevision ?? current, resolution: body.resolution ?? 'Resolved by requested revision.' }
          : request.params.action === 'fail'
            ? { type: 'feedback.fail' as const, noteId: request.params.noteId, failure: body.failure ?? 'The requested edit failed. Retry is available.' }
            : null;
      if (!command) return reply.status(404).send({ error: 'Unknown feedback action.', code: 'not_found' });
      return await store.execute({ expectedRevision: current, idempotencyKey: `feedback-${request.params.action}-${randomUUID()}`, targetState: 'accepted', commands: [command] });
    } catch (error) { return reply.status(error instanceof RevisionError ? 409 : 400).send({ error: error instanceof Error ? error.message : 'Feedback action failed.', code: 'feedback_failed' }); }
  });
}
