import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { OutputVariantDraftSchema, OutputVariantSchema } from '@vpa/shared';
import type { ProjectStore } from '../services/project/store.js';
import { loadStoryboard } from '../services/storyboard/index.js';
import { RevisionStore } from '../services/revisions/store.js';
import { VariantStore, VariantStoreError } from '../services/variants/store.js';
import { validateVariant } from '../services/variants/validate.js';

const UpdateBody = z.object({ variant: OutputVariantDraftSchema, expectedUpdatedAt: z.string().datetime() }).strict();
const RebaseBody = z.object({ expectedUpdatedAt: z.string().datetime() }).strict();

function status(error: unknown): number {
  if (error instanceof VariantStoreError) return error.code === 'not_found' ? 404 : 409;
  return (error as { statusCode?: number }).statusCode ?? 400;
}

export async function registerVariantRoutes(app: FastifyInstance, deps: { store: ProjectStore }) {
  const context = async (projectId: string) => {
    const project = await deps.store.readProject(projectId);
    const storyboard = await loadStoryboard(project.path);
    if (!storyboard) throw Object.assign(new Error('Storyboard not found.'), { statusCode: 404 });
    const revision = await new RevisionStore(project.path).currentRevision();
    return { project, storyboard, revision, variants: new VariantStore(project.path) };
  };

  app.get<{ Params: { id: string } }>('/api/projects/:id/variants', async (request, reply) => {
    try {
      const value = await context(request.params.id);
      return { variants: (await value.variants.list()).map((variant) => validateVariant(variant, value.storyboard, value.project, value.revision)) };
    } catch (error) {
      return reply.status(status(error)).send({ error: error instanceof Error ? error.message : 'Variants unavailable.', code: 'variant_error' });
    }
  });

  app.post<{ Params: { id: string } }>('/api/projects/:id/variants', async (request, reply) => {
    const parsed = OutputVariantDraftSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Variant definition is invalid.', code: 'invalid_request', details: parsed.error.flatten() });
    try {
      const value = await context(request.params.id);
      const variant = await value.variants.create(parsed.data, value.revision, value.project);
      return reply.status(201).send(validateVariant(variant, value.storyboard, value.project, value.revision));
    } catch (error) {
      return reply.status(status(error)).send({ error: error instanceof Error ? error.message : 'Variant could not be created.', code: 'variant_error' });
    }
  });

  app.put<{ Params: { id: string; variantId: string } }>('/api/projects/:id/variants/:variantId', async (request, reply) => {
    const parsed = UpdateBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Variant update is invalid.', code: 'invalid_request' });
    try {
      const value = await context(request.params.id);
      const variant = await value.variants.update(request.params.variantId, parsed.data.variant, parsed.data.expectedUpdatedAt);
      return validateVariant(variant, value.storyboard, value.project, value.revision);
    } catch (error) {
      return reply.status(status(error)).send({ error: error instanceof Error ? error.message : 'Variant could not be updated.', code: 'variant_error' });
    }
  });

  app.post<{ Params: { id: string; variantId: string } }>('/api/projects/:id/variants/:variantId/rebase', async (request, reply) => {
    const parsed = RebaseBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Rebase request is invalid.', code: 'invalid_request' });
    try {
      const value = await context(request.params.id);
      const existing = await value.variants.get(request.params.variantId);
      const candidate = OutputVariantSchema.parse({ ...existing, source_revision: value.revision, source_brand: value.project.brand });
      const blockers = validateVariant(candidate, value.storyboard, value.project, value.revision).blockers;
      if (blockers.some((blocker) => /no longer available|no longer matches/i.test(blocker))) {
        return reply.status(409).send({ error: 'Rebase would detach source-linked content. Repair the listed references first.', code: 'variant_rebase_blocked', blockers });
      }
      const variant = await value.variants.rebase(request.params.variantId, value.revision, value.project, parsed.data.expectedUpdatedAt);
      return validateVariant(variant, value.storyboard, value.project, value.revision);
    } catch (error) {
      return reply.status(status(error)).send({ error: error instanceof Error ? error.message : 'Variant could not be rebased.', code: 'variant_error' });
    }
  });

  app.delete<{ Params: { id: string; variantId: string }; Querystring: { expectedUpdatedAt?: string } }>('/api/projects/:id/variants/:variantId', async (request, reply) => {
    if (!request.query.expectedUpdatedAt) return reply.status(400).send({ error: 'expectedUpdatedAt is required.', code: 'invalid_request' });
    try {
      const value = await context(request.params.id);
      await value.variants.remove(request.params.variantId, request.query.expectedUpdatedAt);
      return { deleted: true };
    } catch (error) {
      return reply.status(status(error)).send({ error: error instanceof Error ? error.message : 'Variant could not be removed.', code: 'variant_error' });
    }
  });
}
