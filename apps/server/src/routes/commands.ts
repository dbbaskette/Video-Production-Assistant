import type { FastifyInstance } from 'fastify';
import { ProjectCommandBatchSchema } from '@vpa/shared';
import type { ProjectStore } from '../services/project/store.js';
import { RevisionError, RevisionStore } from '../services/revisions/store.js';

async function projectRoot(store: ProjectStore, id: string): Promise<string | null> {
  const entry = (await store.readTracker()).projects.find((candidate) => candidate.id === id);
  return entry?.path ?? null;
}

export async function registerCommandRoutes(app: FastifyInstance, deps: { store: ProjectStore }): Promise<void> {
  app.get('/api/projects/:id/revision', async (request, reply) => {
    const { id } = request.params as { id: string };
    const root = await projectRoot(deps.store, id);
    if (!root) return reply.status(404).send({ error: 'Project not found.', code: 'not_found' });
    const revisions = new RevisionStore(root);
    const state = await revisions.readState();
    return { revision: state.currentRevision, acceptedRevision: state.acceptedRevision };
  });

  app.get('/api/projects/:id/revisions', async (request, reply) => {
    const { id } = request.params as { id: string };
    const root = await projectRoot(deps.store, id);
    if (!root) return reply.status(404).send({ error: 'Project not found.', code: 'not_found' });
    const revisions = new RevisionStore(root);
    const state = await revisions.readState();
    const records = await revisions.listRevisions();
    const details = await Promise.all(records.slice(-50).map(async (record) => {
      const snapshot = await revisions.readRevision(record.revision);
      const scenes = snapshot.storyboard?.scenes ?? [];
      const durationSec = scenes.reduce((total, scene) => {
        const compositionMs = scene.composition?.clips.reduce((max, clip) => Math.max(max, clip.timeline_start_ms + clip.source_out_ms - clip.source_in_ms), 0) ?? 0;
        const narrationSec = scene.narration?.chunks?.reduce((sum, chunk) => sum + (chunk.durationSec ?? 0) + (chunk.gapSec ?? 0), 0) ?? 0;
        return total + (compositionMs > 0 ? compositionMs / 1000 : scene.recording?.duration_sec ?? narrationSec);
      }, 0);
      return { revision: record.revision, sceneCount: scenes.length, durationSec, firstSceneId: scenes[0]?.id ?? null, summary: record.commandTypes.join(', ') };
    }));
    return { currentRevision: state.currentRevision, acceptedRevision: state.acceptedRevision, revisions: records, details };
  });

  app.get('/api/projects/:id/revisions/:revision', async (request, reply) => {
    const { id, revision: raw } = request.params as { id: string; revision: string };
    const root = await projectRoot(deps.store, id);
    if (!root) return reply.status(404).send({ error: 'Project not found.', code: 'not_found' });
    const revision = Number.parseInt(raw, 10);
    if (!Number.isInteger(revision) || revision < 0) return reply.status(400).send({ error: 'Revision is invalid.', code: 'invalid_request' });
    try {
      return { revision, ...(await new RevisionStore(root).readRevision(revision)) };
    } catch (error) {
      if (error instanceof RevisionError) return reply.status(404).send({ error: error.message, code: error.code });
      throw error;
    }
  });

  app.post('/api/projects/:id/commands', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = ProjectCommandBatchSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Command batch is invalid.', code: 'invalid_request' });
    const root = await projectRoot(deps.store, id);
    if (!root) return reply.status(404).send({ error: 'Project not found.', code: 'not_found' });
    try {
      return await new RevisionStore(root).execute(parsed.data);
    } catch (error) {
      if (error instanceof RevisionError) {
        const status = error.code === 'revision_not_found' ? 404 : error.code.includes('conflict') || error.code === 'stale_revision' ? 409 : 400;
        return reply.status(status).send({ error: error.message, code: error.code, currentRevision: error.currentRevision });
      }
      throw error;
    }
  });
}
