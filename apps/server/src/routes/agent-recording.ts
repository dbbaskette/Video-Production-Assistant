import type { FastifyInstance } from 'fastify';
import { AgentRecordingPlanUpdateSchema } from '@vpa/shared';
import type { ProjectStore } from '../services/project/store.js';
import { loadStoryboard } from '../services/storyboard/index.js';
import { readAgentRecordingPlan, saveAgentRecordingPlan } from '../services/agent-recording/plan.js';
import { getCurrentAgentRecordingSession } from '../services/agent-recording/session.js';

async function context(store: ProjectStore, projectId: string, sceneId: string) {
  const project = await store.readProject(projectId);
  const storyboard = await loadStoryboard(project.path);
  const scene = storyboard?.scenes.find((item) => item.id === sceneId);
  if (!scene) throw new Error(`Scene not found: ${sceneId}`);
  return { project, scene };
}

export async function registerAgentRecordingRoutes(app: FastifyInstance, deps: { store: ProjectStore }): Promise<void> {
  const base = '/api/projects/:id/scenes/:sceneId/agent-recording';
  app.get(`${base}/plan`, async (req, reply) => {
    const { id, sceneId } = req.params as { id: string; sceneId: string };
    try { const { project, scene } = await context(deps.store, id, sceneId); return readAgentRecordingPlan(project.path, project, scene); }
    catch (error) { return reply.status(404).send({ error: error instanceof Error ? error.message : String(error), code: 'not_found' }); }
  });
  app.put(`${base}/plan`, async (req, reply) => {
    const { id, sceneId } = req.params as { id: string; sceneId: string };
    try { const { project, scene } = await context(deps.store, id, sceneId); return saveAgentRecordingPlan(project.path, project, scene, AgentRecordingPlanUpdateSchema.parse(req.body)); }
    catch (error) { return reply.status(400).send({ error: error instanceof Error ? error.message : String(error), code: 'invalid_plan' }); }
  });
  app.get(`${base}/sessions/current`, async (req, reply) => {
    const { id, sceneId } = req.params as { id: string; sceneId: string };
    try { const { project } = await context(deps.store, id, sceneId); return await getCurrentAgentRecordingSession(project.path, id, sceneId); }
    catch (error) { return reply.status(404).send({ error: error instanceof Error ? error.message : String(error), code: 'not_found' }); }
  });
}
