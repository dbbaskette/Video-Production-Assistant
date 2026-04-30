import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
