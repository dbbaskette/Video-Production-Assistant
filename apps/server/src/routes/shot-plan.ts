import type { FastifyInstance } from 'fastify';
import type { ProjectStore } from '../services/project/store.js';
import type { LlmClient } from '../services/llm/index.js';
import {
  ShotPlanManager,
  type ShotPlanStep,
  type ShotPlanChatTurn,
} from '../services/shot-plan/index.js';
import {
  loadStoryboard,
  saveStoryboard,
  updateScene,
} from '../services/storyboard/index.js';

interface Deps {
  store: ProjectStore;
  llm: LlmClient;
  shotPlanManager: ShotPlanManager;
}

interface RouteParams {
  id: string;
  sceneId: string;
}

async function resolveProjectAndScene(
  store: ProjectStore,
  projectId: string,
  sceneId: string,
) {
  const tracker = await store.readTracker();
  const entry = tracker.projects.find((p) => p.id === projectId);
  if (!entry) {
    throw { statusCode: 404, code: 'project_not_found', message: `Project not found: ${projectId}` };
  }
  const sb = await loadStoryboard(entry.path);
  if (!sb) {
    throw { statusCode: 404, code: 'scene_not_found', message: `No storyboard yet for ${projectId}` };
  }
  const scene = sb.scenes.find((s) => s.id === sceneId);
  if (!scene) {
    throw { statusCode: 404, code: 'scene_not_found', message: `Scene not found: ${sceneId}` };
  }
  return { entry, sb, scene };
}

export async function registerShotPlanRoutes(
  app: FastifyInstance,
  deps: Deps,
): Promise<void> {
  const { store, llm, shotPlanManager } = deps;

  // Plugin-scoped error handler. Other routes in this codebase throw plain
  // `{ statusCode, message }` and rely on Fastify's built-in handler. We throw
  // `{ statusCode, code, message }` so the client gets a stable `code` field
  // (e.g. `project_not_found`, `scene_not_found`) for error-driven UI. This
  // handler translates that shape; the fallthrough `reply.send(err)` leaves
  // unrelated errors to Fastify's default (which honors `statusCode` natively).
  app.setErrorHandler((err, _req, reply) => {
    const e = err as { statusCode?: number; code?: string; message?: string };
    if (e.statusCode && e.code) {
      reply.status(e.statusCode).send({ error: e.message ?? e.code, code: e.code });
      return;
    }
    reply.send(err);
  });

  // GET /api/projects/:id/scenes/:sceneId/shot-plan
  app.get('/api/projects/:id/scenes/:sceneId/shot-plan', async (req) => {
    const { id, sceneId } = req.params as RouteParams;
    const { scene } = await resolveProjectAndScene(store, id, sceneId);

    const session = shotPlanManager.get(id, sceneId);
    if (session) {
      return {
        transcript: session.transcript,
        proposedSteps: session.proposedSteps,
        savedPlan: scene.shot_plan ?? null,
      };
    }
    return {
      transcript: scene.shot_plan_chat ?? [],
      proposedSteps: [],
      savedPlan: scene.shot_plan ?? null,
    };
  });

  // POST /api/projects/:id/scenes/:sceneId/shot-plan/message
  app.post('/api/projects/:id/scenes/:sceneId/shot-plan/message', async (req, reply) => {
    const { id, sceneId } = req.params as RouteParams;
    const { content } = (req.body ?? {}) as { content?: string };
    if (!content || typeof content !== 'string' || !content.trim()) {
      return reply.status(400).send({ error: 'content is required', code: 'invalid_request' });
    }
    const { sb, scene } = await resolveProjectAndScene(store, id, sceneId);
    const session = shotPlanManager.getOrCreate(id, sceneId, scene.shot_plan_chat ?? undefined);

    let assistantTurn;
    try {
      assistantTurn = await session.sendMessage(
        content.trim(),
        llm,
        {
          id: scene.id,
          name: scene.name,
          description: scene.description,
          type: scene.type,
          intent: scene.intent,
        },
        {
          objective: sb.project.objective,
          audience: sb.project.audience,
          sourceDocs: sb.project.source_docs ?? [],
        },
      );
    } catch (err) {
      req.log.error({ err }, 'shot-plan LLM call failed');
      return reply
        .status(502)
        .send({ error: err instanceof Error ? err.message : 'LLM call failed', code: 'llm_error' });
    }

    return {
      reply: assistantTurn.content,
      proposedSteps: session.proposedSteps,
    };
  });

  // POST /api/projects/:id/scenes/:sceneId/shot-plan/accept
  app.post('/api/projects/:id/scenes/:sceneId/shot-plan/accept', async (req, reply) => {
    const { id, sceneId } = req.params as RouteParams;
    const { entry, sb } = await resolveProjectAndScene(store, id, sceneId);

    const session = shotPlanManager.get(id, sceneId);
    if (!session || session.proposedSteps.length === 0) {
      return reply.status(400).send({ error: 'No steps to accept', code: 'no_steps' });
    }

    const shot_plan: ShotPlanStep[] = session.proposedSteps.map((s, i) => ({
      index: i + 1,
      action: s.action,
      ...(s.note ? { note: s.note } : {}),
    }));
    const shot_plan_chat: ShotPlanChatTurn[] = [...session.transcript];

    const updated = updateScene(sb, sceneId, { shot_plan, shot_plan_chat });
    await saveStoryboard(entry.path, updated);
    shotPlanManager.delete(id, sceneId);

    return updated.scenes.find((s) => s.id === sceneId);
  });

  // DELETE /api/projects/:id/scenes/:sceneId/shot-plan
  app.delete('/api/projects/:id/scenes/:sceneId/shot-plan', async (req) => {
    const { id, sceneId } = req.params as RouteParams;
    const { entry, sb } = await resolveProjectAndScene(store, id, sceneId);
    const updated = updateScene(sb, sceneId, {
      shot_plan: undefined,
      shot_plan_chat: undefined,
    });
    await saveStoryboard(entry.path, updated);
    shotPlanManager.delete(id, sceneId);
    return updated.scenes.find((s) => s.id === sceneId);
  });

  // POST /api/projects/:id/scenes/:sceneId/shot-plan/evict
  // Drops the in-memory session only — never touches disk. Used by the UI's
  // Cancel link in the Refine flow so the saved plan stays put.
  app.post('/api/projects/:id/scenes/:sceneId/shot-plan/evict', async (req) => {
    const { id, sceneId } = req.params as RouteParams;
    await resolveProjectAndScene(store, id, sceneId); // 404 if invalid
    shotPlanManager.delete(id, sceneId);
    return { evicted: true };
  });
}
