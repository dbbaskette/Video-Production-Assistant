import type { FastifyInstance } from 'fastify';
import type { ProjectStore } from '../services/project/store.js';
import type { LlmClient } from '../services/llm/index.js';
import { IdeationManager } from '../services/ideation/index.js';
import { createStoryboard, saveStoryboard } from '../services/storyboard/index.js';

interface Deps {
  store: ProjectStore;
  llm: LlmClient;
  ideationManager: IdeationManager;
}

async function resolveProject(store: ProjectStore, projectId: string) {
  const tracker = await store.readTracker();
  const entry = tracker.projects.find((p) => p.id === projectId);
  if (!entry) throw { statusCode: 404, message: `Project not found: ${projectId}` };
  return entry;
}

export async function registerIdeationRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { store, llm, ideationManager } = deps;

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
    await resolveProject(store, id);
    const { content } = req.body as { content?: string };

    if (!content || typeof content !== 'string' || !content.trim()) {
      return reply.status(400).send({ error: 'content is required', code: 'invalid_request' });
    }

    const session = ideationManager.getOrCreate(id);
    const response = await session.sendMessage(content.trim(), llm);
    return response;
  });

  // POST /api/projects/:id/ideation/accept — accept proposed scenes, write storyboard.yaml
  app.post('/api/projects/:id/ideation/accept', async (req, reply) => {
    const { id } = req.params as { id: string };
    const entry = await resolveProject(store, id);

    const session = ideationManager.get(id);
    if (!session) {
      return reply.status(400).send({ error: 'No ideation session found', code: 'no_session' });
    }

    const { proposedScenes } = session.getState();
    if (proposedScenes.length === 0) {
      return reply.status(400).send({ error: 'No scenes to accept', code: 'no_scenes' });
    }

    const project = {
      id: entry.id,
      name: entry.name,
      path: entry.path,
      created: entry.lastOpened ?? new Date().toISOString(),
      brand: null,
    };

    const storyboard = createStoryboard(project, proposedScenes);
    await saveStoryboard(entry.path, storyboard);

    return storyboard;
  });
}
