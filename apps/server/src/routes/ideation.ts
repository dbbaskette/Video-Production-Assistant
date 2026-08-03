import type { FastifyInstance } from 'fastify';
import type { ProjectStore } from '../services/project/store.js';
import { ModelRoutingError, type ModelRouter } from '../services/llm/model-router.js';
import { IdeationManager } from '../services/ideation/index.js';
import { createStoryboard, saveStoryboard } from '../services/storyboard/index.js';
import { sourceDocsNeedSummarization } from '../services/project-source-docs/context.js';

interface Deps {
  store: ProjectStore;
  router: ModelRouter;
  ideationManager: IdeationManager;
}

async function resolveProject(store: ProjectStore, projectId: string) {
  try {
    return await store.readProject(projectId);
  } catch {
    throw { statusCode: 404, message: `Project not found: ${projectId}` };
  }
}

export async function registerIdeationRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { store, router, ideationManager } = deps;

  // GET /api/projects/:id/ideation — get current session state
  app.get('/api/projects/:id/ideation', async (req) => {
    const { id } = req.params as { id: string };
    await resolveProject(store, id);
    const session = ideationManager.getOrCreate(id);
    return session.getState();
  });

  // POST /api/projects/:id/ideation/message — send a user message
  app.post('/api/projects/:id/ideation/message', async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = await resolveProject(store, id);
    const { content } = req.body as { content?: string };

    if (!content || typeof content !== 'string' || !content.trim()) {
      return reply.status(400).send({ error: 'content is required', code: 'invalid_request' });
    }

    try {
      const needsGeneral = await sourceDocsNeedSummarization(project.path);
      const writer = await router.resolveText('writing', project);
      const general = needsGeneral
        ? await router.resolveText('general', project)
        : undefined;
      const session = ideationManager.getOrCreate(id);
      return await session.sendMessage(
        content.trim(),
        writer.client,
        project.objective,
        project.path,
        general?.client,
      );
    } catch (error) {
      if (error instanceof ModelRoutingError) {
        return reply.status(error.statusCode).send({
          error: error.message,
          code: error.code,
          role: error.role,
        });
      }
      req.log.error({ projectId: id, errorName: 'IdeationError' }, 'Ideation failed');
      return reply.status(502).send({
        error: 'Ideation failed. Your existing ideas were not changed.',
        code: 'ideation_failed',
      });
    }
  });

  // POST /api/projects/:id/ideation/accept — accept proposed scenes, write storyboard.yaml
  app.post('/api/projects/:id/ideation/accept', async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = await resolveProject(store, id);

    const session = ideationManager.get(id);
    if (!session) {
      return reply.status(400).send({ error: 'No ideation session found', code: 'no_session' });
    }

    const { proposedScenes } = session.getState();
    if (proposedScenes.length === 0) {
      return reply.status(400).send({ error: 'No scenes to accept', code: 'no_scenes' });
    }

    const storyboard = createStoryboard(project, proposedScenes);
    await saveStoryboard(project.path, storyboard);

    return storyboard;
  });
}
