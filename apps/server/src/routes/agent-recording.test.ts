import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockedFunction,
} from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import type {
  AgentRecordingPlanUpdate,
  AgentRecordingSession,
  Storyboard,
} from '@vpa/shared';
import { ProjectStore } from '../services/project/store.js';
import { saveStoryboard } from '../services/storyboard/index.js';
import { registerAgentRecordingRoutes } from './agent-recording.js';
import {
  appendAgentRecordingPrivateDiagnostic,
  createAgentRecordingSession,
} from '../services/agent-recording/session.js';
import type { AgentRecordingCoordinator } from '../services/agent-recording/coordinator.js';

const SESSION_ID = '64d79770-ee07-4f70-b084-2115dc28e0d3';
const NOW = '2026-07-31T12:00:00.000Z';

function session(
  projectId: string,
  state: AgentRecordingSession['state'] = 'rehearsing',
): AgentRecordingSession {
  return {
    id: SESSION_ID,
    projectId,
    sceneId: 'scene-01',
    state,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe('agent recording routes', () => {
  let app: ReturnType<typeof Fastify>;
  let home: string;
  let projects: string;
  let projectId: string;
  let projectPath: string;
  let store: ProjectStore;
  let rehearse: MockedFunction<AgentRecordingCoordinator['rehearse']>;
  let confirmAndRecord: MockedFunction<AgentRecordingCoordinator['confirmAndRecord']>;
  let cancel: MockedFunction<AgentRecordingCoordinator['cancel']>;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'vpa-agent-home-'));
    projects = await mkdtemp(join(tmpdir(), 'vpa-agent-projects-'));
    store = new ProjectStore({ vpaHome: home, projectsDefault: projects });
    const project = await store.create({ name: 'agent-demo', objective: 'Show the product' });
    projectId = project.id;
    projectPath = project.path;
    const storyboard: Storyboard = {
      schema_version: 1,
      project: { id: project.id, name: project.name, created: project.created },
      scenes: [{
        id: 'scene-01',
        name: 'Welcome',
        description: 'Open the dashboard',
        type: 'browser',
        shot_plan: [{ index: 0, action: 'Open the dashboard' }],
      }],
    };
    await saveStoryboard(project.path, storyboard);
    rehearse = vi.fn(async (
      ..._args: Parameters<AgentRecordingCoordinator['rehearse']>
    ) => session(projectId)) as MockedFunction<AgentRecordingCoordinator['rehearse']>;
    confirmAndRecord = vi.fn(async (
      ..._args: Parameters<AgentRecordingCoordinator['confirmAndRecord']>
    ) => session(projectId, 'recording')) as MockedFunction<AgentRecordingCoordinator['confirmAndRecord']>;
    cancel = vi.fn(async (
      ..._args: Parameters<AgentRecordingCoordinator['cancel']>
    ) => session(projectId, 'interrupted')) as MockedFunction<AgentRecordingCoordinator['cancel']>;
    const coordinator = {
      rehearse,
      confirmAndRecord,
      cancel,
      recoverAttachment: vi.fn(),
      reconcile: vi.fn(),
    } as unknown as AgentRecordingCoordinator;
    app = Fastify();
    await app.register(async (instance: FastifyInstance) =>
      registerAgentRecordingRoutes(instance, { store, coordinator }),
    );
  });

  afterEach(async () => {
    await app.close();
    await rm(home, { recursive: true, force: true });
    await rm(projects, { recursive: true, force: true });
  });

  async function reviewedUpdate(): Promise<AgentRecordingPlanUpdate> {
    const response = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/scenes/scene-01/agent-recording/plan`,
    });
    const plan = response.json();
    return {
      capture: { ...plan.capture, targetApplication: 'Safari' },
      steps: plan.steps,
      preconditions: plan.preconditions,
      checkpoints: ['Dashboard is visible'],
      rehearseFirst: true,
      leadInSec: 2,
      tailSec: 2,
    };
  }

  it('derives, saves, and displays a reviewed plan without creating a session', async () => {
    const url = `/api/projects/${projectId}/scenes/scene-01/agent-recording/plan`;
    const initial = await app.inject({ method: 'GET', url });
    expect(initial.statusCode).toBe(200);
    expect(initial.json().steps[0].action).toBe('Open the dashboard');
    expect(rehearse).not.toHaveBeenCalled();
    expect((await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/scenes/scene-01/agent-recording/sessions/current`,
    })).json()).toBeNull();

    const update = await reviewedUpdate();
    const saved = await app.inject({ method: 'PUT', url, payload: update });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      stale: false,
      capture: { targetApplication: 'Safari' },
      checkpoints: ['Dashboard is visible'],
    });
  });

  it('forwards only the three exact coordinator intents with their accepted statuses', async () => {
    const base = `/api/projects/${projectId}/scenes/scene-01/agent-recording`;
    const update = await reviewedUpdate();

    const rehearsal = await app.inject({ method: 'POST', url: `${base}/rehearse`, payload: update });
    expect(rehearsal.statusCode).toBe(202);
    expect(rehearse).toHaveBeenCalledWith(projectId, 'scene-01', update);

    const confirmation = { confirmed: true as const, planFingerprint: 'reviewed-fingerprint' };
    const recording = await app.inject({
      method: 'POST',
      url: `${base}/sessions/${SESSION_ID}/confirm`,
      payload: confirmation,
    });
    expect(recording.statusCode).toBe(202);
    expect(confirmAndRecord).toHaveBeenCalledWith(
      projectId,
      'scene-01',
      SESSION_ID,
      confirmation,
    );

    const cancelled = await app.inject({
      method: 'POST',
      url: `${base}/sessions/${SESSION_ID}/cancel`,
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancel).toHaveBeenCalledWith(projectId, 'scene-01', SESSION_ID);
  });

  it('rejects malformed plans and confirmations before calling the coordinator', async () => {
    const base = `/api/projects/${projectId}/scenes/scene-01/agent-recording`;
    const badPlan = await app.inject({ method: 'POST', url: `${base}/rehearse`, payload: {} });
    expect(badPlan.statusCode).toBe(400);
    expect(badPlan.json().code).toBe('invalid_plan');
    expect(rehearse).not.toHaveBeenCalled();

    const badConfirmation = await app.inject({
      method: 'POST',
      url: `${base}/sessions/${SESSION_ID}/confirm`,
      payload: { confirmed: false, planFingerprint: '' },
    });
    expect(badConfirmation.statusCode).toBe(400);
    expect(badConfirmation.json().code).toBe('invalid_confirmation');
    expect(confirmAndRecord).not.toHaveBeenCalled();
  });

  it('maps missing scoped resources, conflicts, stale state, and invalid confirmation', async () => {
    const base = `/api/projects/${projectId}/scenes/scene-01/agent-recording`;
    const update = await reviewedUpdate();

    const missingProject = await app.inject({
      method: 'POST',
      url: '/api/projects/missing/scenes/scene-01/agent-recording/rehearse',
      payload: update,
    });
    expect(missingProject.statusCode).toBe(404);

    const missingScene = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/missing/agent-recording/rehearse`,
      payload: update,
    });
    expect(missingScene.statusCode).toBe(404);

    confirmAndRecord.mockRejectedValueOnce(Object.assign(
      new Error('Session file is missing at /private/project/session.json'),
      { code: 'ENOENT' },
    ));
    const missingSession = await app.inject({
      method: 'POST',
      url: `${base}/sessions/${SESSION_ID}/confirm`,
      payload: { confirmed: true, planFingerprint: 'reviewed-fingerprint' },
    });
    expect(missingSession.statusCode).toBe(404);
    expect(JSON.stringify(missingSession.json())).not.toContain('/private/project');

    rehearse.mockRejectedValueOnce(new Error('An agent recording operation is already active for this scene.'));
    const active = await app.inject({ method: 'POST', url: `${base}/rehearse`, payload: update });
    expect(active.statusCode).toBe(409);

    rehearse.mockRejectedValueOnce(new Error('The recording plan is stale and must be reviewed again.'));
    const stale = await app.inject({ method: 'POST', url: `${base}/rehearse`, payload: update });
    expect(stale.statusCode).toBe(409);

    confirmAndRecord.mockRejectedValueOnce(new Error('Recording confirmation does not match the rehearsed plan.'));
    const invalidConfirmation = await app.inject({
      method: 'POST',
      url: `${base}/sessions/${SESSION_ID}/confirm`,
      payload: { confirmed: true, planFingerprint: 'wrong-fingerprint' },
    });
    expect(invalidConfirmation.statusCode).toBe(400);

    confirmAndRecord.mockRejectedValueOnce(new Error('Recording confirmation requires an awaiting-confirmation session.'));
    const illegalState = await app.inject({
      method: 'POST',
      url: `${base}/sessions/${SESSION_ID}/confirm`,
      payload: { confirmed: true, planFingerprint: 'reviewed-fingerprint' },
    });
    expect(illegalState.statusCode).toBe(409);
  });

  it('keeps public reads sanitized and leaves arbitrary session mutation routes removed', async () => {
    const base = `/api/projects/${projectId}/scenes/scene-01/agent-recording`;
    const stored = await createAgentRecordingSession(projectPath, projectId, 'scene-01');
    await appendAgentRecordingPrivateDiagnostic(projectPath, projectId, 'scene-01', stored.id, {
      category: 'local',
      phase: 'test',
      detail: 'Useful private failure token=route-secret /private/path',
    });
    const publicRead = (await app.inject({
      method: 'GET',
      url: `${base}/sessions/current`,
    })).json();
    expect(publicRead).toMatchObject({ id: stored.id, state: 'rehearsing' });
    expect(publicRead).not.toHaveProperty('privateDiagnostics');
    expect(JSON.stringify(publicRead)).not.toMatch(/route-secret|\/private\/path/);
    expect((await app.inject({
      method: 'POST',
      url: `${base}/sessions`,
      payload: { state: 'rehearsing' },
    })).statusCode).toBe(404);
    expect((await app.inject({
      method: 'PATCH',
      url: `${base}/sessions/${SESSION_ID}`,
      payload: { state: 'recording', capProjectPath: '/private/path' },
    })).statusCode).toBe(404);
  });
});
