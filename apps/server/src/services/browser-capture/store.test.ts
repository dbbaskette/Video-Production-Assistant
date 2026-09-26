import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { dumpYaml, loadYaml } from '../../lib/yaml.js';
import { projectFiles } from '../project/paths.js';
import { StoryboardSchema } from '@vpa/shared';
import { BrowserCaptureError, BrowserCaptureStore } from './store.js';

const projectId = '72f0c3a4-e52c-4f49-bf91-cf2bd0f2b94c';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'vpa-browser-capture-'));
  const files = projectFiles(root);
  await writeFile(files.metadata, dumpYaml({ id: projectId, name: 'capture', path: root, created: '2026-09-25T12:00:00.000Z', brand: null, model_routing: {} }));
  await writeFile(files.storyboard, dumpYaml({ schema_version: 1, project: { id: projectId, name: 'capture', created: '2026-09-25T12:00:00.000Z' }, scenes: [{ id: 'scene-01', name: 'Demo', description: 'Demo', type: 'desktop' }] }));
  return { root, files };
}

const webm = (marker: number) => Buffer.from([0x1a, 0x45, 0xdf, 0xa3, marker, marker + 1]);

function captureInput() {
  return {
    sceneId: 'scene-01',
    commonClockOriginMs: 1000,
    tracks: [
      { id: 'track_screen-0001', role: 'screen' as const, kind: 'video' as const, mimeType: 'video/webm;codecs=vp9', timingOriginMs: 0, sharedAudioAvailable: true },
      { id: 'track_mic-0000001', role: 'microphone' as const, kind: 'audio' as const, mimeType: 'audio/webm;codecs=opus', timingOriginMs: 20 },
      { id: 'track_system-0001', role: 'system-audio' as const, kind: 'audio' as const, mimeType: 'audio/webm;codecs=opus', timingOriginMs: 10, sharedAudioAvailable: true },
    ],
  };
}

describe('BrowserCaptureStore', () => {
  it('persists ordered chunks idempotently and rejects gaps or changed retries', async () => {
    const { root, files } = await fixture();
    const store = new BrowserCaptureStore(root);
    const session = await store.create(projectId, captureInput());
    expect(JSON.parse(await readFile(path.join(files.capturesDir, session.id, 'session.json'), 'utf8')).session.status).toBe('recording');

    const first = await store.appendChunk(session.id, 'track_screen-0001', 0, webm(1));
    expect(first.reused).toBe(false);
    expect((await store.appendChunk(session.id, 'track_screen-0001', 0, webm(1))).reused).toBe(true);
    await expect(store.appendChunk(session.id, 'track_screen-0001', 0, webm(2))).rejects.toMatchObject({ code: 'chunk_conflict' });
    await expect(store.appendChunk(session.id, 'track_screen-0001', 2, webm(3))).rejects.toMatchObject({ code: 'invalid_chunk' });
  });

  it('assembles aligned independent tracks, imports immutable assets, and assigns the scene', async () => {
    const { root, files } = await fixture();
    const store = new BrowserCaptureStore(root, { probe: async (_path, kind) => ({ durationSec: kind === 'video' ? 5 : 4.99, width: kind === 'video' ? 1920 : undefined, height: kind === 'video' ? 1080 : undefined }) });
    const session = await store.create(projectId, captureInput());
    for (const [index, track] of captureInput().tracks.entries()) {
      await store.appendChunk(session.id, track.id, 0, webm(index + 1));
    }
    const completed = await store.complete(session.id);
    expect(completed.status).toBe('completed');
    expect(completed.tracks.every((track) => track.asset_id)).toBe(true);
    const storyboard = loadYaml(await readFile(files.storyboard, 'utf8'), StoryboardSchema);
    expect(storyboard.scenes[0]!.recording?.asset_id).toBe(completed.tracks[0]!.asset_id);
    expect(storyboard.scenes[0]!.sources?.map((source) => source.role).sort()).toEqual(['microphone', 'screen', 'system-audio']);
    expect((await readFile(path.join(files.assetOriginalsDir, `${completed.tracks[0]!.asset_id!.slice(6)}.webm`))).subarray(0, 4)).toEqual(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  });

  it('marks abandoned server-side sessions incomplete and keeps them recoverable', async () => {
    const { root } = await fixture();
    let now = new Date('2026-09-25T12:00:00.000Z');
    const store = new BrowserCaptureStore(root, { now: () => now, staleAfterMs: 1_000 });
    const session = await store.create(projectId, captureInput());
    await store.appendChunk(session.id, 'track_screen-0001', 0, webm(1));
    now = new Date('2026-09-25T12:00:02.000Z');
    const listed = await store.list();
    expect(listed[0]).toMatchObject({ status: 'incomplete', failure: { code: 'capture_interrupted', retryable: true } });
    expect((await store.appendChunk(session.id, 'track_screen-0001', 1, webm(2))).sequence).toBe(1);
  });

  it('retains chunks and a retryable failure when validation or alignment fails', async () => {
    const { root, files } = await fixture();
    const store = new BrowserCaptureStore(root, {
      probe: async (filePath) => ({ durationSec: filePath.includes('screen') ? 5 : 4.5 }),
    });
    const session = await store.create(projectId, captureInput());
    for (const [index, track] of captureInput().tracks.entries()) await store.appendChunk(session.id, track.id, 0, webm(index + 1));
    await expect(store.complete(session.id)).rejects.toBeInstanceOf(BrowserCaptureError);
    expect(await store.get(session.id)).toMatchObject({ status: 'failed', failure: { code: 'alignment_failed', retryable: true } });
    expect(await readFile(path.join(files.capturesDir, session.id, 'chunks', 'track_screen-0001', '000000.bin'))).toEqual(webm(1));
  });
});
