import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  AgentRecordingConfirmRequestSchema,
  AgentRecordingPlanUpdateSchema,
  AgentRecordingRehearseRequestSchema,
  AgentRecordingSessionSchema,
} from '@vpa/shared';
import type { ProjectStore } from '../services/project/store.js';
import { loadStoryboard } from '../services/storyboard/index.js';
import { readAgentRecordingPlan, saveAgentRecordingPlan } from '../services/agent-recording/plan.js';
import { getCurrentAgentRecordingSession } from '../services/agent-recording/session.js';
import type { AgentRecordingCoordinator } from '../services/agent-recording/coordinator.js';

interface AgentRecordingRouteDeps {
  store: ProjectStore;
  coordinator: Pick<AgentRecordingCoordinator, 'rehearse' | 'confirmAndRecord' | 'cancel'>;
}

type Intent = 'rehearse' | 'confirm' | 'cancel';

async function context(store: ProjectStore, projectId: string, sceneId: string) {
  const project = await store.readProject(projectId);
  const storyboard = await loadStoryboard(project.path);
  const scene = storyboard?.scenes.find((item) => item.id === sceneId);
  if (!scene) throw new Error(`Scene not found: ${sceneId}`);
  return { project, scene };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): unknown {
  return error && typeof error === 'object' && 'code' in error ? error.code : undefined;
}

function sendIntentError(
  reply: FastifyReply,
  error: unknown,
  intent: Intent,
) {
  const detail = message(error);
  const code = errorCode(error);
  if (
    code === 'ENOENT' ||
    code === 'NOT_FOUND' ||
    /(?:project|scene|session).*not found|does not belong to this scene/i.test(detail)
  ) {
    return reply.code(404).send({
      error: 'Project, scene, or recording session was not found',
      code: 'not_found',
    });
  }
  const knownConflict =
    /already active|already.*session|\bstale\b|requires an awaiting-confirmation session|requires verified rehearsal|requires exact rehearsed target|no longer available|cannot move recording session|terminal recording session/i.test(detail);
  if (code === 'CONFLICT' || knownConflict) {
    return reply.code(409).send({
      error: knownConflict ? detail : 'Agent recording conflicts with the current session state',
      code: 'conflict',
    });
  }
  const invalidConfirmation = intent === 'confirm' && /confirmation does not match/i.test(detail);
  const invalidPlan = intent === 'rehearse' &&
    /requires macOS|terminal scenes cannot|camera and microphone|cursor-disabled capture|only application-window|target application is required/i.test(detail);
  if (code === 'INVALID_PLAN' || code === 'INVALID_CONFIRMATION' || invalidConfirmation || invalidPlan) {
    return reply.code(400).send({
      error: invalidConfirmation || invalidPlan
        ? detail
        : intent === 'confirm'
          ? 'Recording confirmation is invalid'
          : 'Recording plan is invalid',
      code: intent === 'confirm' ? 'invalid_confirmation' : 'invalid_plan',
    });
  }
  return reply.code(500).send({ error: 'Agent recording request failed', code: 'agent_recording_failed' });
}

export async function registerAgentRecordingRoutes(app: FastifyInstance, deps: AgentRecordingRouteDeps): Promise<void> {
  const base = '/api/projects/:id/scenes/:sceneId/agent-recording';
  app.get(`${base}/plan`, async (req, reply) => {
    const { id, sceneId } = req.params as { id: string; sceneId: string };
    try { const { project, scene } = await context(deps.store, id, sceneId); return readAgentRecordingPlan(project.path, project, scene); }
    catch { return reply.status(404).send({ error: 'Project or scene was not found', code: 'not_found' }); }
  });
  app.put(`${base}/plan`, async (req, reply) => {
    const { id, sceneId } = req.params as { id: string; sceneId: string };
    const parsed = AgentRecordingPlanUpdateSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Recording plan is invalid', code: 'invalid_plan' });
    try {
      const { project, scene } = await context(deps.store, id, sceneId);
      return saveAgentRecordingPlan(project.path, project, scene, parsed.data);
    } catch (error) {
      if (errorCode(error) === 'ENOENT' || /(?:project|scene).*not found/i.test(message(error))) {
        return reply.status(404).send({ error: 'Project or scene was not found', code: 'not_found' });
      }
      req.log.error(error);
      return reply.status(500).send({ error: 'Recording plan could not be saved', code: 'agent_recording_failed' });
    }
  });
  app.get(`${base}/sessions/current`, async (req, reply) => {
    const { id, sceneId } = req.params as { id: string; sceneId: string };
    let projectPath: string;
    try {
      projectPath = (await context(deps.store, id, sceneId)).project.path;
    } catch {
      return reply.status(404).send({ error: 'Project or scene was not found', code: 'not_found' });
    }
    try {
      return await getCurrentAgentRecordingSession(projectPath, id, sceneId);
    } catch (error) {
      req.log.error(error);
      return reply.status(500).send({ error: 'Recording session could not be read', code: 'agent_recording_failed' });
    }
  });

  app.post(`${base}/rehearse`, async (req, reply) => {
    const { id, sceneId } = req.params as { id: string; sceneId: string };
    const parsed = AgentRecordingRehearseRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Recording plan is invalid', code: 'invalid_plan' });
    }
    try {
      await context(deps.store, id, sceneId);
      const session = AgentRecordingSessionSchema.parse(
        await deps.coordinator.rehearse(id, sceneId, parsed.data),
      );
      return reply.code(202).send(session);
    } catch (error) {
      return sendIntentError(reply, error, 'rehearse');
    }
  });

  app.post(`${base}/sessions/:sessionId/confirm`, async (req, reply) => {
    const { id, sceneId, sessionId } = req.params as {
      id: string;
      sceneId: string;
      sessionId: string;
    };
    const parsed = AgentRecordingConfirmRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Recording confirmation is invalid',
        code: 'invalid_confirmation',
      });
    }
    try {
      await context(deps.store, id, sceneId);
      const session = AgentRecordingSessionSchema.parse(
        await deps.coordinator.confirmAndRecord(id, sceneId, sessionId, parsed.data),
      );
      return reply.code(202).send(session);
    } catch (error) {
      return sendIntentError(reply, error, 'confirm');
    }
  });

  app.post(`${base}/sessions/:sessionId/cancel`, async (req, reply) => {
    const { id, sceneId, sessionId } = req.params as {
      id: string;
      sceneId: string;
      sessionId: string;
    };
    try {
      await context(deps.store, id, sceneId);
      const session = AgentRecordingSessionSchema.parse(
        await deps.coordinator.cancel(id, sceneId, sessionId),
      );
      return reply.code(200).send(session);
    } catch (error) {
      return sendIntentError(reply, error, 'cancel');
    }
  });
}
