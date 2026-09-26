import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Scene } from '@vpa/shared';
import { projectFiles } from '../project/paths.js';
import { materializeSceneComposition } from './materialize.js';

const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');

describe('materializeSceneComposition', () => {
  it('uses one timing plan for linked trim/reorder, camera overlay, gain, and fades without changing sources', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'vpa-composition-render-'));
    const files = projectFiles(root);
    await mkdir(files.assetOriginalsDir, { recursive: true });
    const screen = Buffer.from('screen-source');
    const mic = Buffer.from('microphone-source');
    const camera = Buffer.from('camera-source');
    const screenId = `asset_${'a'.repeat(64)}`;
    const micId = `asset_${'b'.repeat(64)}`;
    const cameraId = `asset_${'c'.repeat(64)}`;
    await writeFile(path.join(files.assetOriginalsDir, 'screen.webm'), screen);
    await writeFile(path.join(files.assetOriginalsDir, 'mic.webm'), mic);
    await writeFile(path.join(files.assetOriginalsDir, 'camera.webm'), camera);
    const now = '2026-09-25T12:00:00.000Z';
    await writeFile(files.assetManifest, JSON.stringify({ version: 1, assets: [
      { id: screenId, checksum: 'a'.repeat(64), original_name: 'screen.webm', source: '.vpa/assets/originals/screen.webm', origin: 'source', media_kind: 'video', mime_type: 'video/webm', size_bytes: screen.length, imported_at: now, duration_sec: 10, timing_origin_ms: 0, preparation: { status: 'ready', attempts: 1, updated_at: now } },
      { id: micId, checksum: 'b'.repeat(64), original_name: 'mic.webm', source: '.vpa/assets/originals/mic.webm', origin: 'source', media_kind: 'audio', mime_type: 'audio/webm', size_bytes: mic.length, imported_at: now, duration_sec: 10, timing_origin_ms: 20, preparation: { status: 'ready', attempts: 1, updated_at: now } },
      { id: cameraId, checksum: 'c'.repeat(64), original_name: 'camera.webm', source: '.vpa/assets/originals/camera.webm', origin: 'source', media_kind: 'video', mime_type: 'video/webm', size_bytes: camera.length, imported_at: now, duration_sec: 10, timing_origin_ms: 10, preparation: { status: 'ready', attempts: 1, updated_at: now } },
    ] }));
    const scene: Scene = {
      id: 'scene-01', name: 'Demo', description: 'Demo', type: 'desktop',
      composition: {
        version: 1,
        clips: [
          { id: 'clip_first-0001', source_asset_id: screenId, source_role: 'screen', source_in_ms: 1_000, source_out_ms: 4_000, timeline_start_ms: 0, linked_tracks: [{ asset_id: micId, role: 'microphone', source_offset_ms: 20 }, { asset_id: cameraId, role: 'camera', source_offset_ms: 10 }] },
          { id: 'clip_second-0002', source_asset_id: screenId, source_role: 'screen', source_in_ms: 5_000, source_out_ms: 7_000, timeline_start_ms: 3_000, linked_tracks: [{ asset_id: micId, role: 'microphone', source_offset_ms: 20 }] },
        ],
        audio_mix: { original: { gain_db: 0, mute: true, fade_in_ms: 0, fade_out_ms: 0 }, microphone: { gain_db: -6, mute: false, fade_in_ms: 100, fade_out_ms: 200 } },
      },
    };
    let args: string[] = [];
    const result = await materializeSceneComposition(root, scene, {
      hasAudio: async () => true,
      run: async (next) => { args = next; await writeFile(next.at(-1)!, 'derived'); },
    });
    expect(result).toMatchObject({ durationSec: 5, hasAudio: true });
    const graph = args[args.indexOf('-filter_complex') + 1]!;
    expect(graph).toContain('trim=start=1.000:end=4.000');
    expect(graph).toContain('overlay=W-w-24:H-h-24');
    expect(graph).toContain('volume=-6dB');
    expect(graph).toContain('afade=t=in:st=0:d=0.100');
    expect(graph).toContain('concat=n=2:v=1:a=0');
    expect(hash(await readFile(path.join(files.assetOriginalsDir, 'screen.webm')))).toBe(hash(screen));
    expect(hash(await readFile(path.join(files.assetOriginalsDir, 'mic.webm')))).toBe(hash(mic));
  });

  it('omits unavailable shared audio and renders a silent composition safely', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'vpa-composition-silent-'));
    const files = projectFiles(root);
    await mkdir(files.assetOriginalsDir, { recursive: true });
    await writeFile(path.join(files.assetOriginalsDir, 'screen.webm'), 'screen');
    const screenId = `asset_${'d'.repeat(64)}`;
    await writeFile(files.assetManifest, JSON.stringify({ version: 1, assets: [{ id: screenId, checksum: 'd'.repeat(64), original_name: 'screen.webm', source: '.vpa/assets/originals/screen.webm', origin: 'source', media_kind: 'video', mime_type: 'video/webm', size_bytes: 6, imported_at: '2026-09-25T12:00:00.000Z', duration_sec: 2, timing_origin_ms: 0, preparation: { status: 'ready', attempts: 1, updated_at: '2026-09-25T12:00:00.000Z' } }] }));
    let args: string[] = [];
    const result = await materializeSceneComposition(root, { id: 'scene-01', name: 'Silent', description: 'Silent', type: 'desktop', composition: { version: 1, clips: [{ id: 'clip_silent-0001', source_asset_id: screenId, source_role: 'screen', source_in_ms: 0, source_out_ms: 2_000, timeline_start_ms: 0, linked_tracks: [] }], audio_mix: {} } }, { hasAudio: async () => false, run: async (next) => { args = next; } });
    expect(result?.hasAudio).toBe(false);
    expect(args).toContain('-an');
  });
});
