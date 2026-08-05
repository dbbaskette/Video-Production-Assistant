import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ProjectModelRouting, ProjectTrackerEntry } from '@vpa/shared';
import { dumpYaml } from '../../lib/yaml.js';
import { projectFiles, trackerPath } from '../project/paths.js';
import { ProjectStore } from '../project/store.js';
import { ModelRegistry, type ModelsFile } from './model-registry.js';
import { findModelReferences } from './model-references.js';

const tempDirs: string[] = [];

interface ProjectFixture {
  id: string;
  name: string;
  modelRouting: ProjectModelRouting;
  missing?: boolean;
}

function uuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`;
}

async function createRegistry(assignments: ModelsFile['assignments']): Promise<ModelRegistry> {
  const directory = await mkdtemp(path.join(tmpdir(), 'vpa-model-references-registry-'));
  tempDirs.push(directory);
  const filePath = path.join(directory, 'models.json');
  await writeFile(filePath, JSON.stringify({
    version: 2,
    models: [{ id: 'target-model', name: 'Target', provider: 'fake', model: 'fake' }],
    assignments,
  }));
  const registry = new ModelRegistry(filePath);
  await registry.load({});
  return registry;
}

async function createStore(fixtures: ProjectFixture[]): Promise<{ store: ProjectStore; root: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'vpa-model-references-projects-'));
  tempDirs.push(root);
  const vpaHome = path.join(root, 'home');
  const projectsDefault = path.join(root, 'projects');
  await mkdir(vpaHome, { recursive: true });
  await mkdir(projectsDefault, { recursive: true });

  const trackerEntries: ProjectTrackerEntry[] = [];
  for (const [index, fixture] of fixtures.entries()) {
    const projectRoot = path.join(projectsDefault, fixture.name);
    trackerEntries.push({
      id: fixture.id,
      name: fixture.name,
      path: projectRoot,
      lastOpened: '2026-08-01T00:00:00.000Z',
    });
    if (fixture.missing) continue;
    await mkdir(projectRoot, { recursive: true });
    await writeFile(projectFiles(projectRoot).metadata, dumpYaml({
      id: fixture.id,
      name: fixture.name,
      path: projectRoot,
      created: new Date(Date.UTC(2026, 7, 1, 0, 0, index)).toISOString(),
      brand: null,
      model_routing: fixture.modelRouting,
    }));
  }
  await writeFile(trackerPath(vpaHome), JSON.stringify({ version: 1, projects: trackerEntries }));

  return { store: new ProjectStore({ vpaHome, projectsDefault }), root };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('findModelReferences', () => {
  it('returns global and project roles while warning and skipping an unreadable project without exposing paths', async () => {
    const registry = await createRegistry({ writing: 'target-model', general: 'other-model' });
    const missingId = uuid(3);
    const { store, root } = await createStore([
      { id: uuid(1), name: 'alpha', modelRouting: { video_understanding: 'target-model' } },
      { id: uuid(2), name: 'beta', modelRouting: { writing: 'target-model', general: 'target-model' } },
      { id: missingId, name: 'missing', modelRouting: {}, missing: true },
    ]);
    const warn = vi.fn();

    const report = await findModelReferences('target-model', registry, store, warn);

    expect(report).toEqual({
      globalRoles: ['writing'],
      projects: [
        { id: uuid(1), name: 'alpha', roles: ['video-understanding'] },
        { id: uuid(2), name: 'beta', roles: ['writing', 'general'] },
      ],
      truncated: false,
    });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: missingId, projectName: 'missing', error: expect.any(Error) }),
      'Skipping unreadable project while scanning model references',
    );
    expect(JSON.stringify(report)).not.toContain(root);
    expect(JSON.stringify(report)).not.toContain('path');
  });

  it('caps returned project references at 50 and reports truncation', async () => {
    const registry = await createRegistry({});
    const fixtures: ProjectFixture[] = Array.from({ length: 51 }, (_, index) => ({
      id: uuid(index + 1),
      name: `project-${index + 1}`,
      modelRouting: { general: 'target-model' },
    }));
    const { store } = await createStore(fixtures);

    const report = await findModelReferences('target-model', registry, store, vi.fn());

    expect(report.globalRoles).toEqual([]);
    expect(report.projects).toHaveLength(50);
    expect(report.projects[0]).toEqual({ id: uuid(1), name: 'project-1', roles: ['general'] });
    expect(report.projects[49]).toEqual({ id: uuid(50), name: 'project-50', roles: ['general'] });
    expect(report.truncated).toBe(true);
  });
});
