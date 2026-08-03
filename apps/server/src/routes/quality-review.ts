import type { FastifyInstance } from 'fastify';
import type { ProjectStore } from '../services/project/store.js';
import { ModelRoutingError, type ModelRouter } from '../services/llm/model-router.js';
import { loadStoryboard } from '../services/storyboard/index.js';
import { runQualityReview } from '../services/quality-review/index.js';
import type { ReviewResult } from '../services/quality-review/index.js';
import { buildReviewFingerprint } from '../services/workflow-status/fingerprint.js';

interface Deps {
  store: ProjectStore;
  router: ModelRouter;
  workspaceRoot: string;
}

// In-memory cache of last review result per project (clears on server restart)
const reviewCache = new Map<string, ReviewResult>();

export function getQualityReview(projectId: string): ReviewResult | null {
  return reviewCache.get(projectId) ?? null;
}

async function resolveProjectPath(store: ProjectStore, projectId: string): Promise<string> {
  try {
    return (await store.readProject(projectId)).path;
  } catch {
    throw { statusCode: 404, message: `Project not found: ${projectId}` };
  }
}

export async function registerQualityReviewRoutes(
  app: FastifyInstance,
  deps: Deps,
): Promise<void> {
  const { store, router, workspaceRoot } = deps;

  // POST /api/projects/:id/review — run quality review
  app.post('/api/projects/:id/review', async (req, reply) => {
    const { id } = req.params as { id: string };
    let project;
    try {
      project = await store.readProject(id);
    } catch {
      return reply.status(404).send({ error: `Project not found: ${id}`, code: 'not_found' });
    }
    const projectPath = project.path;

    const sb = await loadStoryboard(projectPath);
    if (!sb) return reply.status(404).send({ error: 'No storyboard found', code: 'not_found' });

    try {
      const general = await router.resolveText('general', project);
      const result = {
        ...(await runQualityReview(sb, general.client, workspaceRoot, projectPath)),
        inputFingerprint: buildReviewFingerprint(sb),
      };
      reviewCache.set(id, result);
      return result;
    } catch (error) {
      if (error instanceof ModelRoutingError) {
        return reply.status(error.statusCode).send({
          error: error.message,
          code: error.code,
          role: error.role,
        });
      }
      req.log.error({ projectId: id, errorName: 'QualityReviewError' }, 'Quality review failed');
      return reply.status(500).send({
        error: 'Quality review failed. Your previous review was not changed.',
        code: 'quality_review_failed',
      });
    }
  });

  // GET /api/projects/:id/review — get last review result
  app.get('/api/projects/:id/review', async (req, reply) => {
    const { id } = req.params as { id: string };

    // Verify project exists
    await resolveProjectPath(store, id);

    const cached = reviewCache.get(id);
    if (!cached) {
      return { items: [], summary: { total: 0, info: 0, warn: 0, issue: 0 }, status: null, reviewedAt: null };
    }

    return cached;
  });
}
