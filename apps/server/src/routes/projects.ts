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
    return { projects: tracker.projects };
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
