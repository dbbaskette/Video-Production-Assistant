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
    return { currentRevision: state.currentRevision, acceptedRevision: state.acceptedRevision, revisions: await revisions.listRevisions() };
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
