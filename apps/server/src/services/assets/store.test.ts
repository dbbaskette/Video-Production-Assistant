import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AssetStore } from './store.js';
import { projectFiles } from '../project/paths.js';
import { resolveSafeProjectPath, UnsafeProjectPathError } from '../project/safe-path.js';

async function fixture(name = 'clip.mp4'): Promise<{ root: string; source: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'vpa-assets-test-'));
  const source = path.join(root, name);
  const header = Buffer.concat([Buffer.alloc(4), Buffer.from('ftyp'), Buffer.alloc(24)]);
  await writeFile(source, header);
  return { root, source };
}

const metadata = {
  duration_sec: 12,
  width: 1920,
  height: 1080,
  codec: 'h264',
  fps: 30,
  size_bytes: 32,
};

describe('AssetStore', () => {
  it('stores immutable checksum-addressed originals and deduplicates repeated bytes', async () => {
    const { root, source } = await fixture();
    const store = new AssetStore(root, { probe: vi.fn().mockResolvedValue(metadata) });

    const first = await store.importFile(source, { originalName: 'first.mp4', sourceRole: 'screen' });
    const second = await store.importFile(source, { originalName: 'replacement.mp4' });

    expect(second.id).toBe(first.id);
    expect((await store.list())).toHaveLength(1);
    expect(await readFile(path.join(root, first.source))).toEqual(await readFile(source));
  });

  it('never publishes a manifest entry when persistence fails', async () => {
    const { root, source } = await fixture();
    const store = new AssetStore(root, {
      probe: vi.fn().mockResolvedValue(metadata),
      persist: vi.fn().mockRejectedValue(new Error('disk full')),
    });
    await expect(store.importFile(source, { originalName: 'clip.mp4' })).rejects.toThrow('disk full');
    await expect(readFile(projectFiles(root).assetManifest, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects malformed and over-duration videos', async () => {
    const { root, source } = await fixture();
    const long = new AssetStore(root, { probe: vi.fn().mockResolvedValue({ ...metadata, duration_sec: 1_201 }) });
    await expect(long.importFile(source, { originalName: 'clip.mp4' })).rejects.toMatchObject({ code: 'video_too_long' });

    const bad = path.join(root, 'bad.mp4');
    await writeFile(bad, 'not a video');
    await expect(long.importFile(bad, { originalName: 'bad.mp4' })).rejects.toMatchObject({ code: 'malformed_media' });
  });

  it('registers legacy sources by copying them without deleting the old file', async () => {
    const { root } = await fixture('unused.mp4');
    await mkdir(path.join(root, 'recordings'));
    const legacy = path.join(root, 'recordings', 'scene-01.mp4');
    await writeFile(legacy, Buffer.concat([Buffer.alloc(4), Buffer.from('ftyp'), Buffer.alloc(24)]));
    const store = new AssetStore(root, { probe: vi.fn().mockResolvedValue(metadata) });
    const asset = await store.registerLegacy('recordings/scene-01.mp4');
    expect(asset.legacy_source).toBe('recordings/scene-01.mp4');
    expect(await readFile(legacy)).toHaveLength(32);
  });

  it('keeps failed preparation explicit and lets the user retry it', async () => {
    const { root, source } = await fixture();
    const store = new AssetStore(root, { probe: vi.fn().mockResolvedValue(metadata) });
    const asset = await store.importFile(source, { originalName: 'clip.mp4' });
    const manifestPath = projectFiles(root).assetManifest;
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.assets[0].preparation = {
      status: 'failed',
      attempts: 1,
      updated_at: '2026-09-25T12:00:00.000Z',
      error: { code: 'proxy_failed', message: 'Preview preparation failed.' },
    };
    await writeFile(manifestPath, JSON.stringify(manifest));

    const retried = await store.retryPreparation(asset.id);
    expect(retried.preparation).toMatchObject({ status: 'ready', attempts: 2 });
    expect(retried.preparation.error).toBeUndefined();
  });
});

describe('resolveSafeProjectPath', () => {
  it('rejects traversal and an existing symlink component', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'vpa-safe-path-'));
    await expect(resolveSafeProjectPath(root, '../escape')).rejects.toBeInstanceOf(UnsafeProjectPathError);
    await symlink(tmpdir(), path.join(root, 'linked'));
    await expect(resolveSafeProjectPath(root, 'linked/escape.mp4')).rejects.toBeInstanceOf(UnsafeProjectPathError);
  });
});
