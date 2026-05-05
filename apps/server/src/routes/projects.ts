import type { FastifyInstance } from 'fastify';
import {
  CreateProjectRequestSchema,
  ImportProjectRequestSchema,
  type ListProjectsResponse,
  type ProjectResponse,
} from '@vpa/shared';
import { ProjectStore } from '../services/project/store.js';
import type { ServerConfig } from '../config.js';

interface Deps {
  store: ProjectStore;
  config: ServerConfig;
}

export async function projectsRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { store, config } = deps;

  app.get('/api/projects', async (): Promise<ListProjectsResponse> => {
    const tracker = await store.readTracker();
    // Mark stale entries so the dashboard can dim them + offer a one-click
    // prune. Doing the stat here is cheap (parallel) and avoids the UI
    // having to fan out per-row existence checks.
    const presence = await store.checkExistence();
    return {
      projects: tracker.projects.map((p) => ({
        ...p,
        missing: presence.get(p.id) === false,
      })),
    };
  });

  // POST /api/projects/prune — drop every tracker entry whose directory no
  // longer exists. Returns the entries that were removed so the UI can
  // confirm "Cleaned up N projects". Does not touch disk.
  app.post('/api/projects/prune', async () => {
    const removed = await store.pruneMissing();
    return { removed };
  });

  // DELETE /api/projects/:id/tracker — remove a single entry from the
  // tracker only. Distinct from any future destructive delete that would
  // also touch disk; this is the dashboard "Remove from list" action.
  app.delete('/api/projects/:id/tracker', async (req, reply) => {
    const { id } = req.params as { id: string };
    const removed = await store.removeFromTracker(id);
    if (!removed) return reply.status(404).send({ error: 'Project not found in tracker', code: 'not_found' });
    return { removed: true };
  });

  app.post('/api/projects', async (req, reply) => {
    const parsed = CreateProjectRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: parsed.error.message,
        code: 'invalid_request',
        details: parsed.error.flatten(),
      });
    }
    try {
      const project = await store.create(parsed.data);
      return project satisfies ProjectResponse;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = /exists|not empty|duplicate/i.test(msg) ? 409 : 500;
      return reply.status(status).send({ error: msg, code: 'create_failed' });
    }
  });

  app.post('/api/projects/import', async (req, reply) => {
    const parsed = ImportProjectRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: parsed.error.message,
        code: 'invalid_request',
      });
    }
    try {
      const project = await store.import(parsed.data.path);
      return project satisfies ProjectResponse;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = /No project\.yaml|ENOENT/i.test(msg) ? 404 : 500;
      return reply.status(status).send({ error: msg, code: 'import_failed' });
    }
  });

  app.get('/api/config/defaults', async () => ({
    projectsDefault: config.projectsDefault,
  }));

  // GET full project metadata (including applied brand)
  app.get('/api/projects/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const project = await store.readProject(id);
      return project;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(404).send({ error: msg, code: 'not_found' });
    }
  });

  // PUT update the brand applied to the project
  app.put('/api/projects/:id/brand', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { brand?: { id: string; applied_version: number } | null };
    if (body.brand !== null && body.brand !== undefined) {
      if (typeof body.brand.id !== 'string' || typeof body.brand.applied_version !== 'number') {
        return reply.status(400).send({
          error: 'brand must be { id: string, applied_version: number } or null',
          code: 'invalid_request',
        });
      }
    }
    try {
      const project = await store.setProjectBrand(id, body.brand ?? null);
      return project;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = /not found/i.test(msg) ? 404 : 500;
      return reply.status(status).send({ error: msg, code: status === 404 ? 'not_found' : 'update_failed' });
    }
  });
}
