import type { FastifyInstance } from 'fastify';
import type { ProjectStore } from '../services/project/store.js';
import { ModelRoutingError, type ModelRouter } from '../services/llm/model-router.js';
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
  router: ModelRouter;
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
  let project;
  try {
    project = await store.readProject(projectId);
  } catch {
    throw { statusCode: 404, code: 'project_not_found', message: `Project not found: ${projectId}` };
  }
  const sb = await loadStoryboard(project.path);
  if (!sb) {
    throw { statusCode: 404, code: 'scene_not_found', message: `No storyboard yet for ${projectId}` };
  }
  const scene = sb.scenes.find((s) => s.id === sceneId);
  if (!scene) {
    throw { statusCode: 404, code: 'scene_not_found', message: `Scene not found: ${sceneId}` };
  }
  return { project, sb, scene };
}

export async function registerShotPlanRoutes(
  app: FastifyInstance,
  deps: Deps,
): Promise<void> {
  const { store, router, shotPlanManager } = deps;

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
    const { project, sb, scene } = await resolveProjectAndScene(store, id, sceneId);

    try {
      const writer = await router.resolveText('writing', project);
      const session = shotPlanManager.getOrCreate(id, sceneId, scene.shot_plan_chat ?? undefined);
      const assistantTurn = await session.sendMessage(
        content.trim(),
        writer.client,
        {
          id: scene.id,
          name: scene.name,
          description: scene.description,
          type: scene.type,
          intent: scene.intent,
        },
        {
          objective: project.objective,
          audience: project.audience,
          sourceDocs: sb.project.source_docs ?? [],
        },
        // Pass the full storyboard so the model maintains cross-scene
        // continuity (don't re-open tools earlier scenes already set up,
        // don't duplicate work later scenes will handle).
        sb.scenes.map((s) => ({
          id: s.id,
          name: s.name,
          description: s.description,
          type: s.type,
        })),
      );
      return {
        reply: assistantTurn.content,
        proposedSteps: session.proposedSteps,
      };
    } catch (error) {
      if (error instanceof ModelRoutingError) {
        return reply.status(error.statusCode).send({
          error: error.message,
          code: error.code,
          role: error.role,
        });
      }
      req.log.error({ projectId: id, sceneId, errorName: 'ShotPlanError' }, 'Shot-plan generation failed');
      return reply
        .status(502)
        .send({
          error: 'Shot-plan generation failed. Your existing plan was not changed.',
          code: 'shot_plan_failed',
        });
    }

  });

  // POST /api/projects/:id/scenes/:sceneId/shot-plan/accept
  app.post('/api/projects/:id/scenes/:sceneId/shot-plan/accept', async (req, reply) => {
    const { id, sceneId } = req.params as RouteParams;
    const { project, sb } = await resolveProjectAndScene(store, id, sceneId);

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
    await saveStoryboard(project.path, updated);
    shotPlanManager.delete(id, sceneId);

    return updated.scenes.find((s) => s.id === sceneId);
  });

  // DELETE /api/projects/:id/scenes/:sceneId/shot-plan
  app.delete('/api/projects/:id/scenes/:sceneId/shot-plan', async (req) => {
    const { id, sceneId } = req.params as RouteParams;
    const { project, sb } = await resolveProjectAndScene(store, id, sceneId);
    const updated = updateScene(sb, sceneId, {
      shot_plan: undefined,
      shot_plan_chat: undefined,
    });
    await saveStoryboard(project.path, updated);
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
