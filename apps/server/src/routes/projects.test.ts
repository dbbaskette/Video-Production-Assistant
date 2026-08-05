import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { healthRoutes } from './health.js';
import { projectsRoutes } from './projects.js';
import { ProjectStore } from '../services/project/store.js';
import { ModelRegistry } from '../services/llm/model-registry.js';
import { ModelRouter } from '../services/llm/model-router.js';
import { createLlmFromEntry } from '../services/llm/factory.js';
import { ModelRoutingCoordinator } from '../services/llm/model-routing-coordinator.js';
import { atomicWriteFile } from '../lib/fs-atomic.js';

async function buildTestServer() {
  const home = await mkdtemp(path.join(tmpdir(), 'vpa-routes-home-'));
  const projects = await mkdtemp(path.join(tmpdir(), 'vpa-routes-projects-'));
  const config = {
    port: 0,
    host: '127.0.0.1',
    vpaHome: home,
    projectsDefault: projects,
    webOrigin: 'http://localhost:5173',
    llm: { provider: 'fake' as const },
  };
  let rejectProjectWrites = false;
  const store = new ProjectStore({
    vpaHome: home,
    projectsDefault: projects,
    persist: async (target, contents) => {
      if (rejectProjectWrites) {
        throw new Error(`/private/Users/alice/project.yaml could not be saved at ${target}`);
      }
      await atomicWriteFile(target, contents);
    },
  });
  const registry = new ModelRegistry(path.join(home, 'models.json'));
  await registry.load({});
  const router = new ModelRouter({
    registry,
    createClient: createLlmFromEntry,
    checkCliReady: vi.fn(async () => ({ ready: true })),
  });
  const coordinator = new ModelRoutingCoordinator({ registry, store });
  const app = Fastify();
  await app.register(cors, { origin: [config.webOrigin] });
  await app.register(healthRoutes);
  await app.register(async (i) => projectsRoutes(i, { store, config, router, coordinator }));
  return {
    app,
    home,
    projects,
    registry,
    store,
    rejectProjectWrites() { rejectProjectWrites = true; },
  };
}

describe('projects routes', () => {
  let ctx: Awaited<ReturnType<typeof buildTestServer>>;
  beforeEach(async () => {
    ctx = await buildTestServer();
  });
  afterEach(async () => {
    await ctx.app.close();
    await rm(ctx.home, { recursive: true, force: true });
    await rm(ctx.projects, { recursive: true, force: true });
  });

  it('GET /api/projects returns empty list initially', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/projects' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ projects: [] });
  });

  it('POST /api/projects creates a project', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'demo-1', objective: 'show X' },
    });
    expect(res.statusCode).toBe(200);
    const project = res.json();
    expect(project.name).toBe('demo-1');
    expect(project.path).toBe(path.join(ctx.projects, 'demo-1'));
  });

  it('POST /api/projects rejects duplicate name with 409', async () => {
    await ctx.app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'dup' } });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'dup' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('POST /api/projects rejects invalid name with 400', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'bad name with spaces' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /api/projects/import returns 404 when project.yaml is missing', async () => {
    const empty = await mkdtemp(path.join(tmpdir(), 'vpa-empty-import-'));
    try {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/projects/import',
        payload: { path: empty },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it('GET /api/config/defaults returns the configured projects root', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/config/defaults' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ projectsDefault: ctx.projects });
  });

  it('reads inherited routing, applies an override, and clears it back to inheritance', async () => {
    await ctx.registry.add({
      id: 'writer',
      name: 'Writer',
      provider: 'fake',
      model: 'fake-writer',
    });
    const project = await ctx.store.create({ name: 'routed-project' });

    const inherited = await ctx.app.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/model-routing`,
    });
    expect(inherited.statusCode).toBe(200);
    expect(inherited.json().assignments).toEqual({});
    expect(inherited.json().resolved).toContainEqual(expect.objectContaining({
      role: 'writing',
      scope: 'global',
      entry_id: 'fake',
    }));

    const overridden = await ctx.app.inject({
      method: 'PUT',
      url: `/api/projects/${project.id}/model-routing`,
      payload: { assignments: { writing: 'writer', 'video-understanding': 'writer' } },
    });
    expect(overridden.statusCode).toBe(200);
    expect(overridden.json().assignments).toEqual({
      writing: 'writer',
      'video-understanding': 'writer',
    });
    expect(overridden.json().resolved).toContainEqual(expect.objectContaining({
      role: 'writing',
      scope: 'project',
      entry_id: 'writer',
    }));

    const cleared = await ctx.app.inject({
      method: 'PUT',
      url: `/api/projects/${project.id}/model-routing`,
      payload: { assignments: { writing: null } },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().assignments).toEqual({ 'video-understanding': 'writer' });
    expect(cleared.json().resolved).toContainEqual(expect.objectContaining({
      role: 'writing',
      scope: 'global',
      entry_id: 'fake',
    }));
  });

  it('rejects unknown roles and unknown model entries for project routing', async () => {
    const project = await ctx.store.create({ name: 'invalid-routing' });
    const unknownRole = await ctx.app.inject({
      method: 'PUT',
      url: `/api/projects/${project.id}/model-routing`,
      payload: { assignments: { summary: 'fake' } },
    });
    expect(unknownRole.statusCode).toBe(400);

    const unknownEntry = await ctx.app.inject({
      method: 'PUT',
      url: `/api/projects/${project.id}/model-routing`,
      payload: { assignments: { general: 'missing-model' } },
    });
    expect(unknownEntry.statusCode).toBe(400);
    expect((await ctx.store.readProject(project.id)).model_routing).toEqual({});
  });

  it('composes concurrent project routing requests for different roles', async () => {
    await ctx.registry.add({ id: 'concurrent', name: 'Concurrent', provider: 'fake', model: 'v1' });
    const project = await ctx.store.create({ name: 'concurrent-route-project' });

    const [writing, general] = await Promise.all([
      ctx.app.inject({
        method: 'PUT',
        url: `/api/projects/${project.id}/model-routing`,
        payload: { assignments: { writing: 'concurrent' } },
      }),
      ctx.app.inject({
        method: 'PUT',
        url: `/api/projects/${project.id}/model-routing`,
        payload: { assignments: { general: 'concurrent' } },
      }),
    ]);

    expect(writing.statusCode).toBe(200);
    expect(general.statusCode).toBe(200);
    expect((await ctx.store.readProject(project.id)).model_routing).toEqual({
      writing: 'concurrent',
      general: 'concurrent',
    });
  });

  it('bounds project routing persistence failures without returning filesystem paths', async () => {
    const project = await ctx.store.create({ name: 'failed-project-write' });
    ctx.rejectProjectWrites();

    const response = await ctx.app.inject({
      method: 'PUT',
      url: `/api/projects/${project.id}/model-routing`,
      payload: { assignments: { writing: 'fake' } },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: 'Project model settings could not be saved. Try again.',
      code: 'project_routing_persistence_failed',
    });
    expect(response.body).not.toContain('/private/');
    expect(response.body).not.toContain(project.path);
    expect((await ctx.store.readProject(project.id)).model_routing).toEqual({});
  });
});
