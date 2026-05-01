import type { FastifyInstance } from 'fastify';
import type { ProjectStore } from '../services/project/store.js';
import type { LlmClient } from '../services/llm/index.js';
import { loadStoryboard } from '../services/storyboard/index.js';
import { runQualityReview } from '../services/quality-review/index.js';
import type { ReviewResult } from '../services/quality-review/index.js';

interface Deps {
  store: ProjectStore;
  llm: LlmClient;
  workspaceRoot: string;
}

// In-memory cache of last review result per project (clears on server restart)
const reviewCache = new Map<string, ReviewResult>();

async function resolveProjectPath(store: ProjectStore, projectId: string): Promise<string> {
  const tracker = await store.readTracker();
  const entry = tracker.projects.find((p) => p.id === projectId);
  if (!entry) throw { statusCode: 404, message: `Project not found: ${projectId}` };
  return entry.path;
}

export async function registerQualityReviewRoutes(
  app: FastifyInstance,
  deps: Deps,
): Promise<void> {
  const { store, llm, workspaceRoot } = deps;

  // POST /api/projects/:id/review — run quality review
  app.post('/api/projects/:id/review', async (req, reply) => {
    const { id } = req.params as { id: string };
    const projectPath = await resolveProjectPath(store, id);

    const sb = await loadStoryboard(projectPath);
    if (!sb) return reply.status(404).send({ error: 'No storyboard found', code: 'not_found' });

    const result = await runQualityReview(sb, llm, workspaceRoot);
    reviewCache.set(id, result);

    return result;
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
