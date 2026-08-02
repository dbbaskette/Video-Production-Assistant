import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { registerSettingsRoutes } from './settings.js';
import { ModelRegistry } from '../services/llm/model-registry.js';
import { ModelRouter } from '../services/llm/model-router.js';
import { createLlmFromEntry } from '../services/llm/factory.js';
import { createFakeLlm } from '../services/llm/fake.js';
import { SwappableLlm } from '../services/llm/swappable.js';
import { ProjectStore } from '../services/project/store.js';

async function buildTestServer() {
  const home = await mkdtemp(path.join(tmpdir(), 'vpa-settings-home-'));
  const projects = await mkdtemp(path.join(tmpdir(), 'vpa-settings-projects-'));
  const registry = new ModelRegistry(path.join(home, 'models.json'));
  await registry.load({});
  const store = new ProjectStore({ vpaHome: home, projectsDefault: projects });
  const router = new ModelRouter({
    registry,
    createClient: createLlmFromEntry,
    checkCliReady: vi.fn(async () => ({ ready: true })),
  });
  const llm = new SwappableLlm(createFakeLlm(), 'Fake');
  const app = Fastify({ logger: false });
  await registerSettingsRoutes(app, { registry, router, store, llm });
  return { app, home, projects, registry, store, llm };
}

describe('settings routes', () => {
  let ctx: Awaited<ReturnType<typeof buildTestServer>>;

  beforeEach(async () => {
    ctx = await buildTestServer();
  });

  afterEach(async () => {
    await ctx.app.close();
    await rm(ctx.home, { recursive: true, force: true });
    await rm(ctx.projects, { recursive: true, force: true });
  });

  it('GET /api/settings/models never serializes credentials', async () => {
    await ctx.registry.add({
      id: 'secret-gemini',
      name: 'Secret Gemini',
      provider: 'gemini',
      model: 'gemini-test',
      apiKey: 'top-secret-key',
    });

    const response = await ctx.app.inject({ method: 'GET', url: '/api/settings/models' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toContainEqual(expect.objectContaining({
      id: 'secret-gemini',
      hasApiKey: true,
      ready: true,
    }));
    expect(JSON.stringify(response.json())).not.toContain('top-secret-key');
    expect(response.json().find((entry: { id: string }) => entry.id === 'secret-gemini'))
      .not.toHaveProperty('apiKey');
  });

  it('reads, updates, and clears global model assignments', async () => {
    await ctx.registry.add({
      id: 'writer',
      name: 'Writer',
      provider: 'fake',
      model: 'fake-writer',
    });

    const initial = await ctx.app.inject({ method: 'GET', url: '/api/settings/model-routing' });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({
      assignments: { writing: 'fake', general: 'fake' },
    });
    expect(initial.json().resolved).toHaveLength(3);

    const updated = await ctx.app.inject({
      method: 'PUT',
      url: '/api/settings/model-routing',
      payload: { assignments: { writing: 'writer' } },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ assignments: { writing: 'writer', general: 'fake' } });
    expect(updated.json().resolved).toContainEqual(expect.objectContaining({
      role: 'writing',
      scope: 'global',
      entry_id: 'writer',
    }));

    const cleared = await ctx.app.inject({
      method: 'PUT',
      url: '/api/settings/model-routing',
      payload: { assignments: { writing: null } },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().assignments).not.toHaveProperty('writing');
    expect(cleared.json().resolved).toContainEqual(expect.objectContaining({
      role: 'writing',
      scope: 'global',
      code: 'model_assignment_missing',
    }));
  });

  it('rejects unknown roles and unknown model entries without mutating assignments', async () => {
    const before = ctx.registry.getAssignments();
    const unknownRole = await ctx.app.inject({
      method: 'PUT',
      url: '/api/settings/model-routing',
      payload: { assignments: { summary: 'fake' } },
    });
    expect(unknownRole.statusCode).toBe(400);

    const unknownEntry = await ctx.app.inject({
      method: 'PUT',
      url: '/api/settings/model-routing',
      payload: { assignments: { writing: 'missing-model' } },
    });
    expect(unknownEntry.statusCode).toBe(400);
    expect(ctx.registry.getAssignments()).toEqual(before);
  });

  it('blocks deletion before mutation when global and project assignments reference a model', async () => {
    await ctx.registry.add({
      id: 'in-use',
      name: 'In Use',
      provider: 'fake',
      model: 'fake-in-use',
    });
    await ctx.registry.setAssignments({ writing: 'in-use' });
    const project = await ctx.store.create({ name: 'demo' });
    await ctx.store.setProjectModelRouting(project.id, { general: 'in-use' });

    const response = await ctx.app.inject({
      method: 'DELETE',
      url: '/api/settings/models/in-use',
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      code: 'model_in_use',
      error: 'Reassign this model before deleting it.',
      references: {
        globalRoles: ['writing'],
        projects: [{ id: project.id, name: 'demo', roles: ['general'] }],
        truncated: false,
      },
    });
    expect(ctx.registry.getById('in-use')).toBeDefined();
  });

  it('uses updated credentials on the next routing resolution without a restart', async () => {
    await ctx.registry.add({
      id: 'video-model',
      name: 'Video Model',
      provider: 'gemini',
      model: 'gemini-video',
    });
    await ctx.registry.setAssignments({ 'video-understanding': 'video-model' });

    const unavailable = await ctx.app.inject({ method: 'GET', url: '/api/settings/model-routing' });
    expect(unavailable.json().resolved).toContainEqual(expect.objectContaining({
      role: 'video-understanding',
      code: 'model_unavailable',
    }));

    const updated = await ctx.app.inject({
      method: 'PUT',
      url: '/api/settings/models/video-model',
      payload: { apiKey: 'new-secret-key' },
    });
    expect(updated.statusCode).toBe(200);
    expect(JSON.stringify(updated.json())).not.toContain('new-secret-key');

    const ready = await ctx.app.inject({ method: 'GET', url: '/api/settings/model-routing' });
    expect(ready.json().resolved).toContainEqual(expect.objectContaining({
      role: 'video-understanding',
      ready: true,
      entry_id: 'video-model',
    }));
    expect(JSON.stringify(ready.json())).not.toContain('new-secret-key');
  });

  it('keeps legacy activation assignment-backed while add, update, and delete do not swap', async () => {
    const swap = vi.spyOn(ctx.llm, 'swap');
    await ctx.app.inject({
      method: 'POST',
      url: '/api/settings/models',
      payload: {
        id: 'legacy-choice',
        name: 'Legacy Choice',
        provider: 'fake',
        model: 'legacy-fake',
      },
    });
    await ctx.app.inject({
      method: 'PUT',
      url: '/api/settings/models/legacy-choice',
      payload: { model: 'legacy-fake-updated' },
    });
    await ctx.app.inject({ method: 'DELETE', url: '/api/settings/models/legacy-choice' });
    expect(swap).not.toHaveBeenCalled();

    await ctx.registry.add({
      id: 'legacy-active',
      name: 'Legacy Active',
      provider: 'fake',
      model: 'legacy-active-fake',
    });
    const activated = await ctx.app.inject({
      method: 'POST',
      url: '/api/settings/models/legacy-active/activate',
    });
    expect(activated.statusCode).toBe(200);
    expect(ctx.registry.getAssignments()).toMatchObject({
      writing: 'legacy-active',
      general: 'legacy-active',
    });
    expect(swap).toHaveBeenCalledTimes(1);

    const persisted = await readFile(path.join(ctx.home, 'models.json'), 'utf8');
    expect(JSON.parse(persisted).version).toBe(2);
    expect(persisted).not.toContain('"active"');
  });
});
