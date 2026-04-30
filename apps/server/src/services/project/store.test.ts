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

describe('ProjectStore.import', () => {
  let home: string;
  beforeEach(async () => { home = await makeHome(); });
  afterEach(async () => { await rm(home, { recursive: true, force: true }); });

  it('imports an existing project folder with valid project.yaml', async () => {
    const projectDir = await mkdtemp(path.join(tmpdir(), 'vpa-existing-'));
    try {
      const yaml = `id: 22222222-2222-2222-2222-222222222222
name: imported
path: ${projectDir}
created: 2026-04-29T10:00:00.000Z
objective: pre-existing
`;
      await writeFile(path.join(projectDir, 'project.yaml'), yaml);
      const store = new ProjectStore({ vpaHome: home, projectsDefault: '/unused' });
      const project = await store.import(projectDir);
      expect(project.name).toBe('imported');
      expect(project.id).toBe('22222222-2222-2222-2222-222222222222');
      const tracker = await store.readTracker();
      expect(tracker.projects).toHaveLength(1);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('throws when project.yaml is missing', async () => {
    const empty = await mkdtemp(path.join(tmpdir(), 'vpa-empty-'));
    try {
      const store = new ProjectStore({ vpaHome: home, projectsDefault: '/unused' });
      await expect(store.import(empty)).rejects.toThrow(/project\.yaml/);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it('updates path if importing a project whose id already exists in tracker', async () => {
    const oldDir = await mkdtemp(path.join(tmpdir(), 'vpa-old-'));
    const newDir = await mkdtemp(path.join(tmpdir(), 'vpa-new-'));
    try {
      const id = '33333333-3333-3333-3333-333333333333';
      const oldYaml = `id: ${id}
name: moved
path: ${oldDir}
created: 2026-04-29T10:00:00.000Z
`;
      await writeFile(path.join(oldDir, 'project.yaml'), oldYaml);
      const store = new ProjectStore({ vpaHome: home, projectsDefault: '/unused' });
      await store.import(oldDir);

      const newYaml = oldYaml.replace(oldDir, newDir);
      await writeFile(path.join(newDir, 'project.yaml'), newYaml);
      await store.import(newDir);

      const tracker = await store.readTracker();
      expect(tracker.projects).toHaveLength(1);
      expect(tracker.projects[0]?.path).toBe(newDir);
    } finally {
      await rm(oldDir, { recursive: true, force: true });
      await rm(newDir, { recursive: true, force: true });
    }
  });
});

describe('ProjectStore.touch', () => {
  let home: string;
  beforeEach(async () => { home = await makeHome(); });
  afterEach(async () => { await rm(home, { recursive: true, force: true }); });

  it('updates lastOpened for a tracker entry', async () => {
    const projectsDefault = path.join(home, 'projects-root');
    const store = new ProjectStore({ vpaHome: home, projectsDefault });
    const project = await store.create({ name: 'a' });
    const before = (await store.readTracker()).projects[0]?.lastOpened;
    await new Promise((r) => setTimeout(r, 5));
    await store.touch(project.id);
    const after = (await store.readTracker()).projects[0]?.lastOpened;
    expect(after).not.toBe(before);
  });
});
