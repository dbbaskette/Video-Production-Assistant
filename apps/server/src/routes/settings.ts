import type { FastifyInstance, FastifyReply } from 'fastify';
import { ModelRoutingUpdateSchema } from '@vpa/shared';
import {
  ModelEntrySchema,
  ModelEntryUpdateSchema,
  ModelRegistry,
  ModelRegistryError,
} from '../services/llm/model-registry.js';
import type { ModelRouter } from '../services/llm/model-router.js';
import type { ModelRoutingCoordinator } from '../services/llm/model-routing-coordinator.js';
import type { ProjectStore } from '../services/project/store.js';

interface SettingsDeps {
  registry: ModelRegistry;
  router: ModelRouter;
  store: ProjectStore;
  coordinator: ModelRoutingCoordinator;
}

const INVALID_MODEL_REQUEST = {
  error: 'Model configuration request is invalid.',
  code: 'invalid_request',
} as const;

function registryFailure(
  reply: FastifyReply,
  error: unknown,
) {
  if (error instanceof ModelRegistryError) {
    switch (error.code) {
      case 'invalid_model':
      case 'invalid_assignment':
        return reply.code(400).send({
          error: error.code === 'invalid_assignment'
            ? 'The selected model assignment is invalid.'
            : INVALID_MODEL_REQUEST.error,
          code: error.code === 'invalid_assignment' ? 'invalid_model_assignment' : 'invalid_request',
        });
      case 'model_exists':
        return reply.code(409).send({ error: 'A model with this ID already exists.', code: 'model_exists' });
      case 'model_not_found':
        return reply.code(404).send({ error: 'Model configuration was not found.', code: 'model_not_found' });
      case 'persistence_failed':
        return reply.code(500).send({
          error: 'Model settings could not be saved. Try again.',
          code: 'settings_persistence_failed',
        });
    }
  }
  return reply.code(500).send({
    error: 'Model settings could not be saved. Try again.',
    code: 'settings_persistence_failed',
  });
}

export async function registerSettingsRoutes(
  app: FastifyInstance,
  deps: SettingsDeps,
): Promise<void> {
  const { registry, router, coordinator } = deps;

  // ──────────────────── GET /api/settings/models ────────────────────
  app.get('/api/settings/models', async (_req, reply) => {
    return reply.send(registry.list());
  });

  app.get('/api/settings/model-routing', async (_req, reply) => {
    return reply.send({
      assignments: registry.getAssignments(),
      resolved: await router.describeAll(),
    });
  });

  app.put('/api/settings/model-routing', async (req, reply) => {
    const parsed = ModelRoutingUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Model assignment request is invalid.',
        code: 'invalid_request',
      });
    }

    try {
      await coordinator.setGlobalAssignments(parsed.data.assignments);
      return reply.send({
        assignments: registry.getAssignments(),
        resolved: await router.describeAll(),
      });
    } catch (error) {
      return registryFailure(reply, error);
    }
  });

  // ──────────────────── POST /api/settings/models ───────────────────
  app.post('/api/settings/models', async (req, reply) => {
    const parsed = ModelEntrySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send(INVALID_MODEL_REQUEST);

    try {
      const entry = await registry.add(parsed.data);
      return reply.code(201).send({ ...entry, apiKey: undefined, hasApiKey: !!entry.apiKey });
    } catch (error) {
      return registryFailure(reply, error);
    }
  });

  // ──────────────────── PUT /api/settings/models/:id ────────────────
  app.put<{ Params: { id: string } }>('/api/settings/models/:id', async (req, reply) => {
    const parsed = ModelEntryUpdateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send(INVALID_MODEL_REQUEST);
    try {
      const entry = await registry.update(req.params.id, parsed.data);
      return reply.send({ ...entry, apiKey: undefined, hasApiKey: !!entry.apiKey });
    } catch (error) {
      return registryFailure(reply, error);
    }
  });

  // ──────────────────── DELETE /api/settings/models/:id ──────────────
  app.delete<{ Params: { id: string } }>(
    '/api/settings/models/:id',
    async (req, reply) => {
      try {
        const references = await coordinator.deleteModel(req.params.id);
        if (references) {
          return reply.code(409).send({
            code: 'model_in_use',
            error: 'Reassign this model before deleting it.',
            references,
          });
        }
        return reply.code(204).send();
      } catch (error) {
        return registryFailure(reply, error);
      }
    },
  );
}
