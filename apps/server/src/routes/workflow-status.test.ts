import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Storyboard } from '@vpa/shared';
import { ProjectStore } from '../services/project/store.js';
import { saveStoryboard } from '../services/storyboard/index.js';
import { registerRenderRoutes } from './render.js';
import { registerWorkflowStatusRoutes } from './workflow-status.js';

describe('workflow status and render preflight routes', () => {
  let app: ReturnType<typeof Fastify>;
  let home: string;
  let projects: string;
  let projectId: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'vpa-workflow-home-'));
    projects = await mkdtemp(join(tmpdir(), 'vpa-workflow-projects-'));
    const store = new ProjectStore({ vpaHome: home, projectsDefault: projects });
    const project = await store.create({ name: 'workflow-demo' });
    projectId = project.id;
    const storyboard: Storyboard = { schema_version: 1, project: { id: project.id, name: project.name, created: project.created }, scenes: [{ id: 'scene-01', name: 'Intro', description: 'Open the app', type: 'browser' }] };
    await saveStoryboard(project.path, storyboard);
    app = Fastify();
    await app.register(async (instance: FastifyInstance) => registerWorkflowStatusRoutes(instance, { store }));
    await app.register(async (instance: FastifyInstance) => registerRenderRoutes(instance, { store, vpaHome: home, workspaceRoot: process.cwd(), registryFile: join(home, 'brands.json') }));
  });

  afterEach(async () => { await app.close(); await rm(home, { recursive: true, force: true }); await rm(projects, { recursive: true, force: true }); });

  it('returns one canonical seven-step status with a scene-level next action', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/workflow-status` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ projectId, nextAction: { key: 'open_scene_recording', sceneId: 'scene-01' }, counts: { blockers: 1 } });
    expect(response.json().steps).toHaveLength(7);
  });

  it('recomputes preflight and rejects an incomplete full render', async () => {
    const response = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/render`, payload: {} });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'render_blocked', blockers: [{ code: 'recording_missing', sceneId: 'scene-01' }] });
  });
});
