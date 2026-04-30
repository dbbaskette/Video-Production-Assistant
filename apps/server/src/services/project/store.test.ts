import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProjectStore } from './store.js';

async function makeHome() {
  return mkdtemp(path.join(tmpdir(), 'vpa-store-'));
}

describe('ProjectStore.readTracker', () => {
  let home: string;
  beforeEach(async () => {
    home = await makeHome();
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('returns empty tracker when file does not exist', async () => {
    const store = new ProjectStore({ vpaHome: home, projectsDefault: '/tmp' });
    const tracker = await store.readTracker();
    expect(tracker).toEqual({ version: 1, projects: [] });
  });

  it('reads valid tracker file', async () => {
    await writeFile(
      path.join(home, 'projects.json'),
      JSON.stringify({
        version: 1,
        projects: [
          {
            id: '11111111-1111-1111-1111-111111111111',
            name: 'demo',
            path: '/tmp/demo',
            lastOpened: '2026-04-29T00:00:00.000Z',
          },
        ],
      }),
    );
    const store = new ProjectStore({ vpaHome: home, projectsDefault: '/tmp' });
    const tracker = await store.readTracker();
    expect(tracker.projects).toHaveLength(1);
    expect(tracker.projects[0]?.name).toBe('demo');
  });

  it('throws on malformed tracker', async () => {
    await writeFile(path.join(home, 'projects.json'), '{not json');
    const store = new ProjectStore({ vpaHome: home, projectsDefault: '/tmp' });
    await expect(store.readTracker()).rejects.toThrow();
  });
});

describe('ProjectStore.create', () => {
  let home: string;
  beforeEach(async () => { home = await makeHome(); });
  afterEach(async () => { await rm(home, { recursive: true, force: true }); });

  it('creates a project directory, project.yaml, and tracker entry', async () => {
    const projectsDefault = path.join(home, 'projects-root');
    const store = new ProjectStore({ vpaHome: home, projectsDefault });
    const project = await store.create({ name: 'demo-1', objective: 'show feature X' });

    expect(project.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(project.name).toBe('demo-1');
    expect(project.path).toBe(path.join(projectsDefault, 'demo-1'));
    expect(project.objective).toBe('show feature X');

    const tracker = await store.readTracker();
    expect(tracker.projects).toHaveLength(1);
    expect(tracker.projects[0]?.name).toBe('demo-1');

    const yamlText = await readFile(path.join(project.path, 'project.yaml'), 'utf8');
    expect(yamlText).toContain('name: demo-1');
    expect(yamlText).toContain('objective: show feature X');
  });

  it('rejects creating a project with a duplicate name', async () => {
    const projectsDefault = path.join(home, 'projects-root');
    const store = new ProjectStore({ vpaHome: home, projectsDefault });
    await store.create({ name: 'dup' });
    await expect(store.create({ name: 'dup' })).rejects.toThrow(/exists|duplicate/i);
  });

  it('honors a custom parentDir', async () => {
    const customParent = await mkdtemp(path.join(tmpdir(), 'vpa-custom-'));
    try {
      const store = new ProjectStore({ vpaHome: home, projectsDefault: '/unused' });
      const project = await store.create({ name: 'd', parentDir: customParent });
      expect(project.path).toBe(path.join(customParent, 'd'));
    } finally {
      await rm(customParent, { recursive: true, force: true });
    }
  });

  it('rejects creating into a directory that already contains content', async () => {
    const projectsDefault = path.join(home, 'projects-root');
    const conflictDir = path.join(projectsDefault, 'busy');
    await mkdir(conflictDir, { recursive: true });
    await writeFile(path.join(conflictDir, 'something.txt'), 'x');
    const store = new ProjectStore({ vpaHome: home, projectsDefault });
    await expect(store.create({ name: 'busy' })).rejects.toThrow(/not empty|exists/i);
  });
});
