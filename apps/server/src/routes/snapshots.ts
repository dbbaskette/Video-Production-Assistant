/**
 * Storyboard snapshot history endpoints.
 *
 * GET  /api/projects/:id/snapshots          list rolling backups
 * POST /api/projects/:id/snapshots/:sid/restore   roll back to one
 *
 * Restore itself snapshots the current state first, so accidental rollbacks
 * can be undone via another restore.
 */

import type { FastifyInstance } from 'fastify';
import type { ProjectStore } from '../services/project/store.js';
import { listSnapshots, restoreSnapshot } from '../services/storyboard/snapshots.js';

interface Deps {
  store: ProjectStore;
}

async function resolveProjectPath(store: ProjectStore, projectId: string): Promise<string> {
  const tracker = await store.readTracker();
  const entry = tracker.projects.find((p) => p.id === projectId);
  if (!entry) throw { statusCode: 404, message: `Project not found: ${projectId}` };
  return entry.path;
}

export async function registerSnapshotRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { store } = deps;

  app.get('/api/projects/:id/snapshots', async (req, reply) => {
    const { id } = req.params as { id: string };
    let projectPath: string;
    try {
      projectPath = await resolveProjectPath(store, id);
    } catch {
      return reply.status(404).send({ error: `Project not found: ${id}`, code: 'not_found' });
    }
    const snapshots = await listSnapshots(projectPath);
    return { snapshots };
  });

  app.post('/api/projects/:id/snapshots/:sid/restore', async (req, reply) => {
    const { id, sid } = req.params as { id: string; sid: string };
    let projectPath: string;
    try {
      projectPath = await resolveProjectPath(store, id);
    } catch {
      return reply.status(404).send({ error: `Project not found: ${id}`, code: 'not_found' });
    }
    try {
      await restoreSnapshot(projectPath, sid);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = msg.startsWith('Snapshot not found') ? 'not_found' : 'restore_failed';
      const status = code === 'not_found' ? 404 : 500;
      return reply.status(status).send({ error: msg, code });
    }
    return { restored: true, snapshotId: sid };
  });
}
