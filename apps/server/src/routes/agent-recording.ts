import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
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
import {
  AgentRecordingDomainError,
  isAgentRecordingDomainError,
} from '../services/agent-recording/errors.js';

interface AgentRecordingRouteDeps {
  store: ProjectStore;
  coordinator: Pick<AgentRecordingCoordinator, 'rehearse' | 'confirmAndRecord' | 'cancel'>;
}

const SessionParamsSchema = z.object({
  id: z.string(),
  sceneId: z.string(),
  sessionId: z.string().uuid(),
}).strict();

const publicErrors = {
  NOT_FOUND: {
    status: 404,
    error: 'Project, scene, or recording session was not found',
    code: 'not_found',
  },
  CONFLICT: {
    status: 409,
    error: 'Agent recording conflicts with the current session state',
    code: 'conflict',
  },
  INVALID_PLAN: {
    status: 400,
    error: 'Recording plan is invalid for agent recording',
    code: 'invalid_plan',
  },
  INVALID_CONFIRMATION: {
    status: 400,
    error: 'Recording confirmation is invalid',
    code: 'invalid_confirmation',
  },
} as const;

async function context(store: ProjectStore, projectId: string, sceneId: string) {
  const tracker = await store.readTracker();
  if (!tracker.projects.some((candidate) => candidate.id === projectId)) {
    throw new AgentRecordingDomainError('NOT_FOUND', `Project not found: ${projectId}`);
  }
  const project = await store.readProject(projectId);
  const storyboard = await loadStoryboard(project.path);
  const scene = storyboard?.scenes.find((item) => item.id === sceneId);
  if (!scene) throw new AgentRecordingDomainError('NOT_FOUND', `Scene not found: ${sceneId}`);
  return { project, scene };
}

function sendDomainError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
) {
  if (isAgentRecordingDomainError(error)) {
    const response = publicErrors[error.code];
    return reply.code(response.status).send({ error: response.error, code: response.code });
  }
  request.log.error(error);
  return reply.code(500).send({ error: 'Agent recording request failed', code: 'agent_recording_failed' });
}

function sessionParams(request: FastifyRequest, reply: FastifyReply) {
  const parsed = SessionParamsSchema.safeParse(request.params);
  if (parsed.success) return parsed.data;
  reply.code(404).send({
    error: publicErrors.NOT_FOUND.error,
    code: publicErrors.NOT_FOUND.code,
  });
  return null;
}

export async function registerAgentRecordingRoutes(app: FastifyInstance, deps: AgentRecordingRouteDeps): Promise<void> {
  const base = '/api/projects/:id/scenes/:sceneId/agent-recording';
  app.get(`${base}/plan`, async (req, reply) => {
    const { id, sceneId } = req.params as { id: string; sceneId: string };
    try { const { project, scene } = await context(deps.store, id, sceneId); return readAgentRecordingPlan(project.path, project, scene); }
    catch (error) { return sendDomainError(req, reply, error); }
  });
  app.put(`${base}/plan`, async (req, reply) => {
    const { id, sceneId } = req.params as { id: string; sceneId: string };
    const parsed = AgentRecordingPlanUpdateSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Recording plan is invalid', code: 'invalid_plan' });
    try {
      const { project, scene } = await context(deps.store, id, sceneId);
      return saveAgentRecordingPlan(project.path, project, scene, parsed.data);
    } catch (error) {
      return sendDomainError(req, reply, error);
    }
  });
  app.get(`${base}/sessions/current`, async (req, reply) => {
    const { id, sceneId } = req.params as { id: string; sceneId: string };
    let projectPath: string;
    try {
      projectPath = (await context(deps.store, id, sceneId)).project.path;
    } catch (error) {
      return sendDomainError(req, reply, error);
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
      return sendDomainError(req, reply, error);
    }
  });

  app.post(`${base}/sessions/:sessionId/confirm`, async (req, reply) => {
    const params = sessionParams(req, reply);
    if (!params) return;
    const { id, sceneId, sessionId } = params;
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
      return sendDomainError(req, reply, error);
    }
  });

  app.post(`${base}/sessions/:sessionId/cancel`, async (req, reply) => {
    const params = sessionParams(req, reply);
    if (!params) return;
    const { id, sceneId, sessionId } = params;
    try {
      await context(deps.store, id, sceneId);
      const session = AgentRecordingSessionSchema.parse(
        await deps.coordinator.cancel(id, sceneId, sessionId),
      );
      return reply.code(200).send(session);
    } catch (error) {
      return sendDomainError(req, reply, error);
    }
  });
}
