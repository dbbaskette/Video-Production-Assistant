import type { FastifyInstance } from 'fastify';
import type { ProjectStore } from '../services/project/store.js';
import { generateExportManifest } from '../services/export/index.js';
import { exportBundle } from '../services/export/bundle.js';

interface Deps {
  store: ProjectStore;
}

async function resolveProjectPath(store: ProjectStore, projectId: string): Promise<string> {
  const tracker = await store.readTracker();
  const entry = tracker.projects.find((p) => p.id === projectId);
  if (!entry) throw { statusCode: 404, message: `Project not found: ${projectId}` };
  return entry.path;
}

export async function registerExportRoutes(
  app: FastifyInstance,
  deps: Deps,
): Promise<void> {
  const { store } = deps;

  // POST /api/projects/:id/export — generate export bundle
  app.post<{ Params: { id: string } }>(
    '/api/projects/:id/export',
    async (req, reply) => {
      const { id } = req.params;
      try {
        const projectPath = await resolveProjectPath(store, id);
        const result = await exportBundle(projectPath);
        return result;
      } catch (err: any) {
        if (err?.statusCode === 404) {
          return reply.status(404).send({ error: err.message, code: 'not_found' });
        }
        const msg = err instanceof Error ? err.message : String(err);
        if (/No storyboard/i.test(msg)) {
          return reply.status(400).send({ error: msg, code: 'no_storyboard' });
        }
        return reply.status(500).send({ error: msg, code: 'export_failed' });
      }
    },
  );

  // GET /api/projects/:id/export/manifest — get manifest without exporting
  app.get<{ Params: { id: string } }>(
    '/api/projects/:id/export/manifest',
    async (req, reply) => {
      const { id } = req.params;
      try {
        const projectPath = await resolveProjectPath(store, id);
        const manifest = await generateExportManifest(projectPath);
        return manifest;
      } catch (err: any) {
        if (err?.statusCode === 404) {
          return reply.status(404).send({ error: err.message, code: 'not_found' });
        }
        const msg = err instanceof Error ? err.message : String(err);
        if (/No storyboard/i.test(msg)) {
          return reply.status(400).send({ error: msg, code: 'no_storyboard' });
        }
        return reply.status(500).send({ error: msg, code: 'manifest_failed' });
      }
    },
  );
}
