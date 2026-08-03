import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { registerSettingsRoutes } from './settings.js';
import { ModelRegistry } from '../services/llm/model-registry.js';
import { ModelRouter } from '../services/llm/model-router.js';
import { createLlmFromEntry } from '../services/llm/factory.js';
import { ProjectStore } from '../services/project/store.js';
import { ModelRoutingCoordinator } from '../services/llm/model-routing-coordinator.js';
import { atomicWriteFile } from '../lib/fs-atomic.js';

async function buildTestServer() {
  const home = await mkdtemp(path.join(tmpdir(), 'vpa-settings-home-'));
  const projects = await mkdtemp(path.join(tmpdir(), 'vpa-settings-projects-'));
  let rejectRegistryWrites = false;
  const registry = new ModelRegistry(path.join(home, 'models.json'), async (target, contents) => {
    if (rejectRegistryWrites) {
      throw new Error(`/private/Users/alice/.vpa/models.json could not be saved at ${target}`);
    }
    await atomicWriteFile(target, contents);
  });
  await registry.load({});
  const store = new ProjectStore({ vpaHome: home, projectsDefault: projects });
  const router = new ModelRouter({
    registry,
    createClient: createLlmFromEntry,
    checkCliReady: vi.fn(async () => ({ ready: true })),
  });
  const coordinator = new ModelRoutingCoordinator({ registry, store });
  const app = Fastify({ logger: false });
  await registerSettingsRoutes(app, { registry, router, store, coordinator });
  return {
    app,
    home,
    projects,
    registry,
    store,
    rejectRegistryWrites() { rejectRegistryWrites = true; },
  };
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

  it('does not alter role assignments when catalog entries are added, updated, or deleted', async () => {
    const before = ctx.registry.getAssignments();
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
    expect(ctx.registry.getAssignments()).toEqual(before);
  });

  it.each([
    ['unknown provider', {
      id: 'invalid-provider', name: 'Invalid', provider: 'mystery', model: 'x',
    }],
    ['undeclared key', {
      id: 'extra-field', name: 'Invalid', provider: 'fake', model: 'x', active: true,
    }],
    ['wrong field type', {
      id: 'wrong-type', name: 42, provider: 'fake', model: 'x',
    }],
  ])('rejects create requests with %s using one bounded validation response', async (_label, payload) => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/settings/models',
      payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'Model configuration request is invalid.',
      code: 'invalid_request',
    });
    expect(ctx.registry.getById(String(payload.id))).toBeUndefined();
  });

  it.each([
    ['id mutation', { id: 'replacement-id' }],
    ['provider mutation', { provider: 'gemini' }],
    ['undeclared key', { active: true }],
    ['wrong field type', { model: 99 }],
  ])('rejects update requests with %s without changing the entry', async (_label, payload) => {
    await ctx.registry.add({ id: 'strict-update', name: 'Strict', provider: 'fake', model: 'v1' });

    const response = await ctx.app.inject({
      method: 'PUT',
      url: '/api/settings/models/strict-update',
      payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'Model configuration request is invalid.',
      code: 'invalid_request',
    });
    expect(ctx.registry.getById('strict-update')).toMatchObject({
      id: 'strict-update', provider: 'fake', model: 'v1',
    });
  });

  it('accepts strict create and update requests while keeping identity immutable', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/settings/models',
      payload: { id: 'valid-entry', name: 'Valid', provider: 'fake', model: 'v1' },
    });
    expect(created.statusCode).toBe(201);

    const updated = await ctx.app.inject({
      method: 'PUT',
      url: '/api/settings/models/valid-entry',
      payload: { name: 'Renamed', model: 'v2' },
    });
    expect(updated.statusCode).toBe(200);
    expect(ctx.registry.getById('valid-entry')).toMatchObject({
      id: 'valid-entry', provider: 'fake', name: 'Renamed', model: 'v2',
    });
  });

  it.each(['assignment', 'create', 'update', 'delete'] as const)(
    'returns one bounded 500 when %s persistence fails without exposing a filesystem path',
    async (operation) => {
      if (operation === 'update' || operation === 'delete') {
        await ctx.registry.add({
          id: `persist-${operation}`,
          name: 'Persistence target',
          provider: 'fake',
          model: 'v1',
        });
      }
      ctx.rejectRegistryWrites();
      const request = operation === 'assignment'
        ? { method: 'PUT' as const, url: '/api/settings/model-routing', payload: { assignments: { writing: null } } }
        : operation === 'create'
          ? { method: 'POST' as const, url: '/api/settings/models', payload: { id: 'persist-create', name: 'Create', provider: 'fake', model: 'v1' } }
          : operation === 'update'
            ? { method: 'PUT' as const, url: '/api/settings/models/persist-update', payload: { model: 'v2' } }
            : { method: 'DELETE' as const, url: '/api/settings/models/persist-delete' };

      const response = await ctx.app.inject(request);

      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({
        error: 'Model settings could not be saved. Try again.',
        code: 'settings_persistence_failed',
      });
      expect(response.body).not.toContain('/private/');
      expect(response.body).not.toContain(ctx.home);
    },
  );
});
