import { describe, expect, it } from 'vitest';
import {
  AssetManifestSchema,
  AssetSchema,
  Job,
  ProjectCommandBatchSchema,
  RecordingSchema,
} from './index.js';

const checksum = 'a'.repeat(64);
const asset = {
  id: `asset_${checksum}`,
  checksum,
  original_name: 'demo.mp4',
  source: `.vpa/assets/originals/${checksum}.mp4`,
  media_kind: 'video',
  mime_type: 'video/mp4',
  size_bytes: 42,
  imported_at: '2026-09-25T12:00:00.000Z',
  duration_sec: 10,
  timing_origin_ms: 0,
  preparation: {
    status: 'ready',
    attempts: 1,
    updated_at: '2026-09-25T12:00:00.000Z',
  },
} as const;

describe('foundation contracts', () => {
  it('accepts immutable assets and rejects unsafe or over-limit metadata', () => {
    expect(AssetSchema.parse(asset).id).toBe(asset.id);
    expect(AssetSchema.safeParse({ ...asset, source: '../escape.mp4' }).success).toBe(false);
    expect(AssetSchema.safeParse({ ...asset, duration_sec: 1_201 }).success).toBe(false);
    expect(AssetSchema.safeParse({ ...asset, size_bytes: 2 * 1024 ** 3 + 1 }).success).toBe(false);
  });

  it('rejects duplicate IDs and checksums in one manifest', () => {
    expect(AssetManifestSchema.safeParse({ version: 1, assets: [asset, asset] }).success).toBe(false);
  });

  it('keeps legacy recordings compatible while supporting stable asset references', () => {
    expect(RecordingSchema.safeParse({ source: 'recordings/scene-01.mp4' }).success).toBe(true);
    expect(RecordingSchema.safeParse({
      source: asset.source,
      asset_id: asset.id,
      source_role: 'screen',
      timing_origin_ms: 120,
    }).success).toBe(true);
  });

  it('bounds command batches and requires restore to stand alone', () => {
    const base = { expectedRevision: 0, idempotencyKey: 'request-1234' };
    expect(ProjectCommandBatchSchema.safeParse({
      ...base,
      commands: [{ type: 'scene.assign-asset', sceneId: 'scene-01', assetId: asset.id }],
    }).success).toBe(true);
    expect(ProjectCommandBatchSchema.safeParse({
      ...base,
      commands: [
        { type: 'revision.restore', revision: 0 },
        { type: 'scene.delete', sceneId: 'scene-01' },
      ],
    }).success).toBe(false);
  });

  it('supports recoverable interrupted jobs and structured failures', () => {
    const parsed = Job.parse({
      id: '4e7cc4f8-fd9c-42ca-9fa0-88a0e0ef45e9',
      type: 'render',
      status: 'interrupted',
      created: '2026-09-25T12:00:00.000Z',
      updated: '2026-09-25T12:01:00.000Z',
      events: [],
      failure: { code: 'server_restarted', message: 'Job interrupted by restart.', retryable: true },
    });
    expect(parsed.status).toBe('interrupted');
  });
});
