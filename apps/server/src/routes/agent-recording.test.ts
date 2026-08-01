import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Storyboard } from '@vpa/shared';
import { ProjectStore } from '../services/project/store.js';
import { saveStoryboard } from '../services/storyboard/index.js';
import { registerAgentRecordingRoutes } from './agent-recording.js';
import { appendAgentRecordingPrivateDiagnostic, createAgentRecordingSession } from '../services/agent-recording/session.js';

describe('agent recording routes', () => {
  let app: ReturnType<typeof Fastify>;
  let home: string;
  let projects: string;
  let projectId: string;
  let projectPath: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'vpa-agent-home-'));
    projects = await mkdtemp(join(tmpdir(), 'vpa-agent-projects-'));
    const store = new ProjectStore({ vpaHome: home, projectsDefault: projects });
    const project = await store.create({ name: 'agent-demo', objective: 'Show the product' });
    projectId = project.id;
    projectPath = project.path;
    const storyboard: Storyboard = { schema_version: 1, project: { id: project.id, name: project.name, created: project.created }, scenes: [{ id: 'scene-01', name: 'Welcome', description: 'Open the dashboard', type: 'browser', shot_plan: [{ index: 0, action: 'Open the dashboard' }] }] };
    await saveStoryboard(project.path, storyboard);
    app = Fastify();
    await app.register(async (instance: FastifyInstance) => registerAgentRecordingRoutes(instance, { store }));
  });

  afterEach(async () => { await app.close(); await rm(home, { recursive: true, force: true }); await rm(projects, { recursive: true, force: true }); });

  it('derives, saves, and returns a reviewed scene plan', async () => {
    const url = `/api/projects/${projectId}/scenes/scene-01/agent-recording/plan`;
    const initial = await app.inject({ method: 'GET', url });
    expect(initial.statusCode).toBe(200);
    expect(initial.json().steps[0].action).toBe('Open the dashboard');
    const update = { capture: { ...initial.json().capture, targetApplication: 'Safari' }, steps: initial.json().steps, preconditions: initial.json().preconditions, checkpoints: ['Dashboard is visible'], rehearseFirst: true, leadInSec: 2, tailSec: 2 };
    const saved = await app.inject({ method: 'PUT', url, payload: update });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ stale: false, capture: { targetApplication: 'Safari' }, checkpoints: ['Dashboard is visible'] });
  });

  it('keeps only session reads public until coordinator routes are registered', async () => {
    const base = `/api/projects/${projectId}/scenes/scene-01/agent-recording`;
    expect((await app.inject({ method: 'GET', url: `${base}/sessions/current` })).json()).toBeNull();
    const session = await createAgentRecordingSession(projectPath, projectId, 'scene-01');
    await appendAgentRecordingPrivateDiagnostic(projectPath, projectId, 'scene-01', session.id, {
      category: 'local', phase: 'test', detail: 'Useful private failure token=route-secret /private/path',
    });
    const publicRead = (await app.inject({ method: 'GET', url: `${base}/sessions/current` })).json();
    expect(publicRead).toMatchObject({ id: session.id, state: 'rehearsing' });
    expect(publicRead).not.toHaveProperty('privateDiagnostics');
    expect(JSON.stringify(publicRead)).not.toMatch(/route-secret|\/private\/path/);
    expect((await app.inject({ method: 'POST', url: `${base}/sessions`, payload: { state: 'rehearsing' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PATCH', url: `${base}/sessions/session-id`, payload: { state: 'recording', capProjectPath: '/private/path' } })).statusCode).toBe(404);
  });
});
