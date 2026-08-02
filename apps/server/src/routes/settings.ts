import type { FastifyInstance } from 'fastify';
import { ModelRoutingUpdateSchema } from '@vpa/shared';
import { ModelRegistry, type ModelProvider } from '../services/llm/model-registry.js';
import { createLlmFromEntry } from '../services/llm/factory.js';
import type { SwappableLlm } from '../services/llm/swappable.js';
import { RetryingLlm } from '../services/llm/retrying.js';
import type { ModelRouter } from '../services/llm/model-router.js';
import { findModelReferences } from '../services/llm/model-references.js';
import type { ProjectStore } from '../services/project/store.js';

interface SettingsDeps {
  registry: ModelRegistry;
  router: ModelRouter;
  store: ProjectStore;
  llm: SwappableLlm;
}

export async function registerSettingsRoutes(
  app: FastifyInstance,
  deps: SettingsDeps,
): Promise<void> {
  const { registry, router, store, llm } = deps;

  /** Build a retry-wrapped client to hand to the SwappableLlm. */
  const wrap = (entry: Parameters<typeof createLlmFromEntry>[0]) =>
    new RetryingLlm(createLlmFromEntry(entry), undefined, (m) => app.log.warn(m));

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
        error: parsed.error.message,
        code: 'invalid_request',
      });
    }

    try {
      await registry.setAssignments(parsed.data.assignments);
      return reply.send({
        assignments: registry.getAssignments(),
        resolved: await router.describeAll(),
      });
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : String(error),
        code: 'invalid_model_assignment',
      });
    }
  });

  // ──────────────────── POST /api/settings/models ───────────────────
  app.post<{
    Body: {
      id: string;
      name: string;
      provider: ModelProvider;
      model: string;
      endpoint?: string;
      apiKey?: string;
    };
  }>('/api/settings/models', async (req, reply) => {
    const { id, name, provider, model, endpoint, apiKey } = req.body;

    if (!id || !name || !provider || !model) {
      return reply.code(400).send({ error: 'id, name, provider, and model are required' });
    }

    try {
      const entry = await registry.add({ id, name, provider, model, endpoint, apiKey });
      return reply.code(201).send({ ...entry, apiKey: undefined, hasApiKey: !!entry.apiKey });
    } catch (err: any) {
      return reply.code(409).send({ error: err.message });
    }
  });

  // ──────────────────── PUT /api/settings/models/:id ────────────────
  app.put<{
    Params: { id: string };
    Body: {
      name?: string;
      model?: string;
      endpoint?: string;
      apiKey?: string;
    };
  }>('/api/settings/models/:id', async (req, reply) => {
    try {
      const entry = await registry.update(req.params.id, req.body);
      return reply.send({ ...entry, apiKey: undefined, hasApiKey: !!entry.apiKey });
    } catch (err: any) {
      return reply.code(404).send({ error: err.message });
    }
  });

  // ──────────────────── POST /api/settings/models/:id/activate ──────
  app.post<{ Params: { id: string } }>(
    '/api/settings/models/:id/activate',
    async (req, reply) => {
      // Deprecated compatibility endpoint. It updates assignment-backed
      // compatibility state only; persisted active flags no longer exist.
      try {
        const entry = await registry.activate(req.params.id);
        llm.swap(wrap(entry), `${entry.name} (${entry.model})`);
        app.log.info(`Switched LLM to: ${entry.name} (${entry.provider}/${entry.model})`);
        return reply.send({ ...entry, apiKey: undefined, hasApiKey: !!entry.apiKey });
      } catch (err: any) {
        return reply.code(404).send({ error: err.message });
      }
    },
  );

  // ──────────────────── DELETE /api/settings/models/:id ──────────────
  app.delete<{ Params: { id: string } }>(
    '/api/settings/models/:id',
    async (req, reply) => {
      try {
        const references = await findModelReferences(
          req.params.id,
          registry,
          store,
          (fields, message) => app.log.warn(fields, message),
        );
        if (references.globalRoles.length > 0 || references.projects.length > 0) {
          return reply.code(409).send({
            code: 'model_in_use',
            error: 'Reassign this model before deleting it.',
            references,
          });
        }
        await registry.remove(req.params.id);
        return reply.code(204).send();
      } catch (err: any) {
        return reply.code(404).send({ error: err.message });
      }
    },
  );

  // ──────────────────── GET /api/settings/models/active ─────────────
  app.get('/api/settings/models/active', async (_req, reply) => {
    // Deprecated compatibility endpoint backed by the writing assignment.
    const active = registry.getActive();
    if (!active) return reply.code(404).send({ error: 'No active model' });
    return reply.send({
      id: active.id,
      name: active.name,
      provider: active.provider,
      model: active.model,
      endpoint: active.endpoint,
      label: llm.getLabel(),
    });
  });
}
