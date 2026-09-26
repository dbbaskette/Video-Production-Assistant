import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectStore } from '../services/project/store.js';
import { saveStoryboard } from '../services/storyboard/index.js';
import { registerProductionRoutes } from './production.js';

describe('production recipes', () => {
  let app: ReturnType<typeof Fastify>;
  let home: string;
  let projects: string;
  let projectId: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'vpa-production-home-'));
    projects = await mkdtemp(join(tmpdir(), 'vpa-production-projects-'));
    const store = new ProjectStore({ vpaHome: home, projectsDefault: projects });
    const project = await store.create({ name: 'recipe-demo' });
    projectId = project.id;
    await mkdir(join(project.path, 'recordings'), { recursive: true });
    await writeFile(join(project.path, 'recordings', 'demo.mp4'), 'source');
    await saveStoryboard(project.path, { schema_version: 1, project: { id: project.id, name: project.name, created: project.created }, scenes: [{ id: 'scene-01', name: 'Demo', description: 'Show the feature', type: 'desktop', recording: { source: 'recordings/demo.mp4', source_role: 'screen', duration_sec: 4 } }] });
    app = Fastify();
    app.post('/api/projects/:id/render', async () => ({ jobId: '11111111-1111-4111-8111-111111111111', status: 'running' }));
    await registerProductionRoutes(app, { store });
  });

  afterEach(async () => { await app.close(); await rm(home, { recursive: true, force: true }); await rm(projects, { recursive: true, force: true }); });

  it('inspects real sources and dispatches the playable render job', async () => {
    const inspected = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/production/recipes/feature-demo/inspect` });
    expect(inspected.json()).toMatchObject({ recipe: 'feature-demo', supported: true, sources: [{ sceneId: 'scene-01', source: 'recordings/demo.mp4', sourceRole: 'screen' }] });
    const run = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/production/recipes/feature-demo/run` });
    expect(run.statusCode).toBe(202);
    expect(run.json()).toMatchObject({ recipe: 'feature-demo', revision: 1, jobId: '11111111-1111-4111-8111-111111111111', status: 'running' });
  });

  it('fails cleanly before dispatch when sources are missing or feedback is unresolved', async () => {
    expect((await app.inject({ method: 'POST', url: `/api/projects/${projectId}/production/recipes/revise-this-draft/run` })).json()).toMatchObject({ code: 'recipe_blocked', inspection: { supported: false } });
  });
});
