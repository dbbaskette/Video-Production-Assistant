import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../project/store.js';
import { ModelRegistry } from './model-registry.js';
import { ModelRoutingCoordinator } from './model-routing-coordinator.js';
import type { ModelReferenceReport } from './model-references.js';

const directories: string[] = [];

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

async function fixture(options: {
  findReferences?: (entryId: string, registry: ModelRegistry, store: ProjectStore) => Promise<ModelReferenceReport>;
} = {}) {
  const home = await mkdtemp(path.join(tmpdir(), 'vpa-routing-coordinator-home-'));
  const projects = await mkdtemp(path.join(tmpdir(), 'vpa-routing-coordinator-projects-'));
  directories.push(home, projects);
  const registry = new ModelRegistry(path.join(home, 'models.json'));
  await registry.load({});
  await registry.add({ id: 'target', name: 'Target', provider: 'fake', model: 'target' });
  const store = new ProjectStore({ vpaHome: home, projectsDefault: projects });
  const coordinator = new ModelRoutingCoordinator({
    registry,
    store,
    findReferences: options.findReferences,
  });
  return { registry, store, coordinator };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('ModelRoutingCoordinator', () => {
  it('serializes concurrent project role mutations through one invariant boundary', async () => {
    const ctx = await fixture();
    const project = await ctx.store.create({ name: 'compose-project' });

    await Promise.all([
      ctx.coordinator.setProjectAssignments(project.id, { writing: 'target' }),
      ctx.coordinator.setProjectAssignments(project.id, { general: 'target' }),
    ]);

    expect((await ctx.store.readProject(project.id)).model_routing).toEqual({
      writing: 'target',
      general: 'target',
    });
  });

  it.each(['global', 'project'] as const)(
    'blocks deletion when a queued %s assignment is acknowledged first',
    async (scope) => {
      const ctx = await fixture();
      const project = await ctx.store.create({ name: `${scope}-first` });
      const assignment = scope === 'global'
        ? ctx.coordinator.setGlobalAssignments({ writing: 'target' })
        : ctx.coordinator.setProjectAssignments(project.id, { writing: 'target' });
      const deletion = ctx.coordinator.deleteModel('target');

      await assignment;
      const references = await deletion;

      expect(references).toMatchObject(scope === 'global'
        ? { globalRoles: ['writing'] }
        : { projects: [{ id: project.id, roles: ['writing'] }] });
      expect(ctx.registry.getById('target')).toBeDefined();
    },
  );

  it.each(['global', 'project'] as const)(
    'finishes deletion first and rejects a later %s assignment without a dangling ID',
    async (scope) => {
      const scanStarted = deferred();
      const releaseScan = deferred();
      const findReferences = vi.fn(async () => {
        scanStarted.resolve();
        await releaseScan.promise;
        return { globalRoles: [], projects: [], truncated: false };
      });
      const ctx = await fixture({ findReferences });
      const project = await ctx.store.create({ name: `${scope}-delete-first` });

      const deletion = ctx.coordinator.deleteModel('target');
      await scanStarted.promise;
      const assignment = scope === 'global'
        ? ctx.coordinator.setGlobalAssignments({ writing: 'target' })
        : ctx.coordinator.setProjectAssignments(project.id, { writing: 'target' });
      releaseScan.resolve();

      await expect(deletion).resolves.toBeNull();
      await expect(assignment).rejects.toMatchObject({ code: 'invalid_assignment' });
      expect(ctx.registry.getById('target')).toBeUndefined();
      expect(ctx.registry.getAssignments()).not.toContain({ writing: 'target' });
      expect((await ctx.store.readProject(project.id)).model_routing).toEqual({});
    },
  );
});
