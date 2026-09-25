import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { atomicWriteFile } from '../../lib/fs-atomic.js';
import { dumpYaml, loadYaml } from '../../lib/yaml.js';
import { projectFiles } from '../project/paths.js';
import { RevisionStore } from './store.js';
import { StoryboardSchema } from '@vpa/shared';

const projectId = '72f0c3a4-e52c-4f49-bf91-cf2bd0f2b94c';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'vpa-revisions-test-'));
  const files = projectFiles(root);
  await writeFile(files.metadata, dumpYaml({
    id: projectId,
    name: 'demo',
    path: root,
    created: '2026-09-25T12:00:00.000Z',
    brand: null,
    model_routing: {},
  }));
  await writeFile(files.storyboard, dumpYaml({
    schema_version: 1,
    project: { id: projectId, name: 'demo', created: '2026-09-25T12:00:00.000Z' },
    scenes: [{ id: 'scene-01', name: 'Intro', description: 'Original', type: 'desktop' }],
  }));
  return { root, files };
}

describe('RevisionStore', () => {
  it('enforces expected revisions and idempotency semantics', async () => {
    const { root } = await fixture();
    const store = new RevisionStore(root);
    const batch = {
      expectedRevision: 0,
      idempotencyKey: 'rename-0001',
      targetState: 'accepted' as const,
      commands: [{ type: 'project.patch' as const, patch: { objective: 'Teach the feature' } }],
    };
    const first = await store.execute(batch);
    expect(first.revision).toBe(1);
    expect(first.state).toBe('accepted');
    expect((await store.readState()).acceptedRevision).toBe(1);
    expect(await store.execute(batch)).toEqual(first);
    await expect(store.execute({ ...batch, idempotencyKey: 'rename-0002' })).rejects.toMatchObject({
      code: 'stale_revision',
      currentRevision: 1,
    });
    await expect(store.execute({
      ...batch,
      commands: [{ type: 'project.patch', patch: { objective: 'Changed payload' } }],
    })).rejects.toMatchObject({ code: 'idempotency_conflict' });
  });

  it('applies a batch fully and restores an earlier snapshot as a new revision', async () => {
    const { root, files } = await fixture();
    const store = new RevisionStore(root);
    await store.execute({
      expectedRevision: 0,
      idempotencyKey: 'batch-000001',
      commands: [
        { type: 'scene.put', scene: { id: 'scene-01', name: 'Changed', description: 'Changed', type: 'desktop' } },
        { type: 'scene.add', scene: { id: 'scene-02', name: 'Second', description: 'Second', type: 'desktop' } },
        { type: 'scene.reorder', sceneIds: ['scene-02', 'scene-01'] },
      ],
    });
    let storyboard = loadYaml(await readFile(files.storyboard, 'utf8'), StoryboardSchema);
    expect(storyboard.scenes.map((scene) => scene.id)).toEqual(['scene-02', 'scene-01']);

    const restored = await store.execute({
      expectedRevision: 1,
      idempotencyKey: 'restore-0001',
      commands: [{ type: 'revision.restore', revision: 0 }],
    });
    expect(restored).toMatchObject({ revision: 2, restoredFrom: 0 });
    storyboard = loadYaml(await readFile(files.storyboard, 'utf8'), StoryboardSchema);
    expect(storyboard.scenes).toHaveLength(1);
    expect(storyboard.scenes[0]?.name).toBe('Intro');
  });

  it('does not partially commit a batch when a later command is invalid', async () => {
    const { root, files } = await fixture();
    const before = await readFile(files.storyboard, 'utf8');
    const store = new RevisionStore(root);
    await expect(store.execute({
      expectedRevision: 0,
      idempotencyKey: 'invalid-0001',
      commands: [
        { type: 'scene.put', scene: { id: 'scene-01', name: 'Changed', description: 'Changed', type: 'desktop' } },
        { type: 'scene.delete', sceneId: 'missing' },
      ],
    })).rejects.toMatchObject({ code: 'invalid_command' });
    expect(await readFile(files.storyboard, 'utf8')).toBe(before);
    expect(await store.currentRevision()).toBe(0);
  });

  it('reconciles legacy endpoint writes into authoritative revision history', async () => {
    const { root, files } = await fixture();
    const store = new RevisionStore(root);
    expect(await store.currentRevision()).toBe(0);

    const storyboard = loadYaml(await readFile(files.storyboard, 'utf8'), StoryboardSchema);
    storyboard.scenes[0]!.description = 'Changed by a legacy endpoint';
    await writeFile(files.storyboard, dumpYaml(storyboard));

    expect(await store.currentRevision()).toBe(1);
    expect(await store.listRevisions()).toContainEqual(expect.objectContaining({
      revision: 1,
      commandTypes: ['external-mutation'],
      state: 'accepted',
    }));
    await expect(store.execute({
      expectedRevision: 0,
      idempotencyKey: 'stale-legacy-0001',
      commands: [{ type: 'project.patch', patch: { audience: 'Developers' } }],
    })).rejects.toMatchObject({ code: 'stale_revision', currentRevision: 1 });
  });

  it('rejects invalid timed scene parameters before committing', async () => {
    const { root } = await fixture();
    const store = new RevisionStore(root);
    await expect(store.execute({
      expectedRevision: 0,
      idempotencyKey: 'timing-00001',
      commands: [{
        type: 'scene.put',
        scene: {
          id: 'scene-01',
          name: 'Intro',
          description: 'Invalid timing',
          type: 'desktop',
          lower_thirds: [{ title: 'Too late', style: 'minimal', in_sec: 5, out_sec: 2 }],
        },
      }],
    })).rejects.toThrow();
    expect(await store.currentRevision()).toBe(0);
  });

  it('rolls documents back when persistence fails before the revision commit marker', async () => {
    const { root, files } = await fixture();
    const before = await readFile(files.storyboard, 'utf8');
    let failed = false;
    const persist = async (target: string, data: string) => {
      if (!failed && target === files.revisionState) {
        failed = true;
        throw new Error('disk full');
      }
      await atomicWriteFile(target, data);
    };
    const store = new RevisionStore(root, { persist });
    await expect(store.execute({
      expectedRevision: 0,
      idempotencyKey: 'failure-0001',
      commands: [{ type: 'scene.put', scene: { id: 'scene-01', name: 'Changed', description: 'Changed', type: 'desktop' } }],
    })).rejects.toThrow('disk full');
    expect(await readFile(files.storyboard, 'utf8')).toBe(before);
    expect(await store.currentRevision()).toBe(0);
  });
});
