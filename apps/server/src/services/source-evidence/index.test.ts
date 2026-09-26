import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Asset, Scene } from '@vpa/shared';
import { SourceEvidenceError, SourceEvidenceService } from './index.js';

const asset: Asset = { id: `asset_${'a'.repeat(64)}`, checksum: 'a'.repeat(64), original_name: 'source.mp4', source: '.vpa/assets/originals/source.mp4', origin: 'source', media_kind: 'video', mime_type: 'video/mp4', size_bytes: 10, imported_at: '2026-09-25T12:00:00.000Z', duration_sec: 10, timing_origin_ms: 0, preparation: { status: 'ready', attempts: 1, updated_at: '2026-09-25T12:00:00.000Z' } };
const scene: Scene = { id: 'scene-01', name: 'Demo', description: 'Demo', type: 'desktop', composition: { version: 1, audio_mix: {}, clips: [{ id: 'clip_source-001', source_asset_id: asset.id, source_role: 'screen', source_in_ms: 0, source_out_ms: 10_000, timeline_start_ms: 0, linked_tracks: [] }] } };
const model = { apiKey: 'secret', model: 'gemini-test', summary: { role: 'video-understanding' as const, scope: 'project' as const, entry_id: 'video-model', provider: 'gemini' as const, model: 'gemini-test', name: 'Gemini', capabilities: { text: true, video: true, image: true }, ready: true } };

describe('SourceEvidenceService', () => {
  it('caches word-aligned Gemini transcription by immutable source/model/settings and emits matching SRT', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'vpa-evidence-'));
    const sourcePath = path.join(root, 'source.mp4');
    await writeFile(sourcePath, 'source');
    const generateWithVideo = vi.fn().mockResolvedValue(JSON.stringify({ words: [
      { text: 'hello', start_ms: 100, end_ms: 450, confidence: 0.95, speaker: 'A' },
      { text: 'there', start_ms: 900, end_ms: 1_300, confidence: 0.75, speaker: 'B' },
    ] }));
    const service = new SourceEvidenceService({ transport: {
      uploadVideo: vi.fn().mockResolvedValue({ name: 'files/1', uri: 'gemini://1', mimeType: 'video/mp4', state: 'ACTIVE' }),
      waitForFileActive: vi.fn().mockResolvedValue({ name: 'files/1', uri: 'gemini://1', mimeType: 'video/mp4', state: 'ACTIVE' }),
      generateWithVideo,
      deleteFile: vi.fn().mockResolvedValue(true),
    } });
    const first = await service.ensureTranscript({ projectRoot: root, asset, sourcePath, model, scene });
    const second = await service.ensureTranscript({ projectRoot: root, asset, sourcePath, model, scene });
    expect(second).toEqual(first);
    expect(generateWithVideo).toHaveBeenCalledTimes(1);
    const withSrt = await service.writeMappedSrt(root, scene, first);
    expect(await readFile(path.join(root, withSrt.subtitles!.srt), 'utf8')).toContain('hello there');
    expect(first).toMatchObject({ provider: 'gemini', model: 'gemini-test', coverage: [{ start_ms: 0, end_ms: 10_000 }] });
  });

  it('creates bounded source-time artifacts and fails without exposing provider details', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'vpa-evidence-artifact-'));
    const sourcePath = path.join(root, 'source.mp4');
    await writeFile(sourcePath, 'source');
    const args: string[][] = [];
    const service = new SourceEvidenceService({ run: async (next) => { args.push(next); await writeFile(next.at(-1)!, 'artifact'); } });
    const item = await service.createArtifact({ projectRoot: root, asset, sourcePath, kind: 'excerpt', startMs: 2_000, endMs: 12_000 });
    expect(item).toMatchObject({ kind: 'excerpt', source_start_ms: 2_000, source_end_ms: 12_000, source_sha256: asset.checksum });
    expect(args[0]).toContain('10.000');
    await expect(service.createArtifact({ projectRoot: root, asset, sourcePath, kind: 'excerpt', startMs: 0, endMs: 31_000 })).rejects.toBeInstanceOf(SourceEvidenceError);
  });
});
