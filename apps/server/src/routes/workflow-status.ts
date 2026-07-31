import type { FastifyInstance } from 'fastify';
import type { ProjectStore } from '../services/project/store.js';
import { loadStoryboard } from '../services/storyboard/index.js';
import { computeWorkflowStatus } from '../services/workflow-status/index.js';
import { getQualityReview } from './quality-review.js';

export async function registerWorkflowStatusRoutes(app: FastifyInstance, deps: { store: ProjectStore }): Promise<void> {
  app.get('/api/projects/:id/workflow-status', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const project = await deps.store.readProject(id);
      const storyboard = await loadStoryboard(project.path);
      return await computeWorkflowStatus({ projectPath: project.path, project, storyboard, review: getQualityReview(id) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('Project not found')) return reply.status(404).send({ error: message, code: 'not_found' });
      throw error;
    }
  });
}
