import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
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

  it('applies linked clip edits atomically and restores the prior composition', async () => {
    const { root, files } = await fixture();
    const now = '2026-09-25T12:00:00.000Z';
    const screenId = `asset_${'a'.repeat(64)}`;
    const micId = `asset_${'b'.repeat(64)}`;
    await mkdir(files.assetsDir, { recursive: true });
    await writeFile(files.assetManifest, JSON.stringify({
      version: 1,
      assets: [
        { id: screenId, checksum: 'a'.repeat(64), original_name: 'screen.webm', source: '.vpa/assets/originals/screen.webm', origin: 'source', media_kind: 'video', mime_type: 'video/webm', size_bytes: 100, imported_at: now, duration_sec: 10, timing_origin_ms: 0, preparation: { status: 'ready', attempts: 1, updated_at: now } },
        { id: micId, checksum: 'b'.repeat(64), original_name: 'mic.webm', source: '.vpa/assets/originals/mic.webm', origin: 'source', media_kind: 'audio', mime_type: 'audio/webm', size_bytes: 100, imported_at: now, duration_sec: 10, timing_origin_ms: 0, preparation: { status: 'ready', attempts: 1, updated_at: now } },
      ],
    }));
    const store = new RevisionStore(root);
    await store.execute({
      expectedRevision: 0,
      idempotencyKey: 'composition-set-0001',
      commands: [{
        type: 'composition.set',
        sceneId: 'scene-01',
        composition: {
          version: 1,
          clips: [{ id: 'clip_original-0001', source_asset_id: screenId, source_role: 'screen', source_in_ms: 0, source_out_ms: 10_000, timeline_start_ms: 0, linked_tracks: [{ asset_id: micId, role: 'microphone', source_offset_ms: 30 }] }],
          audio_mix: {},
        },
      }],
    });
    await store.execute({
      expectedRevision: 1,
      idempotencyKey: 'composition-edit-0001',
      commands: [
        { type: 'clip.split', sceneId: 'scene-01', clipId: 'clip_original-0001', splitSourceMs: 4_000, leftClipId: 'clip_left-00000001', rightClipId: 'clip_right-0000001' },
        { type: 'clip.duplicate', sceneId: 'scene-01', clipId: 'clip_right-0000001', newClipId: 'clip_copy-00000001' },
        { type: 'audio.mix.set', sceneId: 'scene-01', role: 'microphone', settings: { gain_db: -6, mute: false, fade_in_ms: 100, fade_out_ms: 200 } },
      ],
    });
    let storyboard = loadYaml(await readFile(files.storyboard, 'utf8'), StoryboardSchema);
    expect(storyboard.scenes[0]!.composition!.clips.map((clip) => [clip.id, clip.timeline_start_ms])).toEqual([
      ['clip_left-00000001', 0],
      ['clip_right-0000001', 4_000],
      ['clip_copy-00000001', 10_000],
    ]);
    expect(storyboard.scenes[0]!.composition!.clips.every((clip) => clip.linked_tracks[0]?.asset_id === micId)).toBe(true);
    expect(storyboard.scenes[0]!.composition!.audio_mix.microphone?.gain_db).toBe(-6);

    await store.execute({
      expectedRevision: 2,
      idempotencyKey: 'composition-edit-0002',
      commands: [
        { type: 'clip.trim', sceneId: 'scene-01', clipId: 'clip_left-00000001', sourceInMs: 500, sourceOutMs: 3_500 },
        { type: 'clip.reorder', sceneId: 'scene-01', clipIds: ['clip_copy-00000001', 'clip_left-00000001', 'clip_right-0000001'] },
        { type: 'clip.delete', sceneId: 'scene-01', clipId: 'clip_right-0000001' },
      ],
    });
    storyboard = loadYaml(await readFile(files.storyboard, 'utf8'), StoryboardSchema);
    expect(storyboard.scenes[0]!.composition!.clips.map((clip) => [clip.id, clip.timeline_start_ms])).toEqual([
      ['clip_copy-00000001', 0],
      ['clip_left-00000001', 6_000],
    ]);
    expect(storyboard.scenes[0]!.composition!.clips[1]).toMatchObject({ source_in_ms: 500, source_out_ms: 3_500 });

    await store.execute({ expectedRevision: 3, idempotencyKey: 'composition-restore-1', commands: [{ type: 'revision.restore', revision: 1 }] });
    storyboard = loadYaml(await readFile(files.storyboard, 'utf8'), StoryboardSchema);
    expect(storyboard.scenes[0]!.composition!.clips).toHaveLength(1);
  });

  it('rejects a linked edit batch without partially changing the composition', async () => {
    const { root, files } = await fixture();
    const screenId = `asset_${'c'.repeat(64)}`;
    await mkdir(files.assetsDir, { recursive: true });
    await writeFile(files.assetManifest, JSON.stringify({ version: 1, assets: [{ id: screenId, checksum: 'c'.repeat(64), original_name: 'screen.webm', source: '.vpa/assets/originals/screen.webm', origin: 'source', media_kind: 'video', mime_type: 'video/webm', size_bytes: 100, imported_at: '2026-09-25T12:00:00.000Z', duration_sec: 10, timing_origin_ms: 0, preparation: { status: 'ready', attempts: 1, updated_at: '2026-09-25T12:00:00.000Z' } }] }));
    const store = new RevisionStore(root);
    await store.execute({ expectedRevision: 0, idempotencyKey: 'composition-set-0002', commands: [{ type: 'composition.set', sceneId: 'scene-01', composition: { version: 1, clips: [{ id: 'clip_original-0002', source_asset_id: screenId, source_role: 'screen', source_in_ms: 0, source_out_ms: 10_000, timeline_start_ms: 0, linked_tracks: [] }], audio_mix: {} } }] });
    const before = await readFile(files.storyboard, 'utf8');
    await expect(store.execute({
      expectedRevision: 1,
      idempotencyKey: 'composition-bad-0001',
      commands: [
        { type: 'clip.trim', sceneId: 'scene-01', clipId: 'clip_original-0002', sourceInMs: 1_000, sourceOutMs: 9_000 },
        { type: 'clip.split', sceneId: 'scene-01', clipId: 'clip_original-0002', splitSourceMs: 99_000, leftClipId: 'clip_bad-left-001', rightClipId: 'clip_bad-right-01' },
      ],
    })).rejects.toMatchObject({ code: 'invalid_command' });
    expect(await readFile(files.storyboard, 'utf8')).toBe(before);
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
