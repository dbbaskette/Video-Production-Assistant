import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectStore } from '../services/project/store.js';
import { projectFiles } from '../services/project/paths.js';
import { loadStoryboard, saveStoryboard } from '../services/storyboard/index.js';
import { registerAssistanceRoutes } from './assistance.js';

describe('assistance routes', () => {
  let app: ReturnType<typeof Fastify>;
  let home: string;
  let projects: string;
  let projectId: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'vpa-assist-home-'));
    projects = await mkdtemp(join(tmpdir(), 'vpa-assist-projects-'));
    const store = new ProjectStore({ vpaHome: home, projectsDefault: projects });
    const project = await store.create({ name: 'assist' });
    projectId = project.id;
    const assetId = `asset_${'a'.repeat(64)}`;
    const microphoneId = `asset_${'c'.repeat(64)}`;
    const files = projectFiles(project.path);
    await mkdir(files.assetsDir, { recursive: true });
    await writeFile(files.assetManifest, JSON.stringify({ version: 1, assets: [
      { id: assetId, checksum: 'a'.repeat(64), original_name: 'demo.mp4', source: '.vpa/assets/originals/demo.mp4', origin: 'source', media_kind: 'video', mime_type: 'video/mp4', size_bytes: 1, imported_at: '2026-09-25T12:00:00.000Z', duration_sec: 30, timing_origin_ms: 0, preparation: { status: 'ready', attempts: 1, updated_at: '2026-09-25T12:00:00.000Z' } },
      { id: microphoneId, checksum: 'c'.repeat(64), original_name: 'mic.webm', source: '.vpa/assets/originals/mic.webm', origin: 'source', media_kind: 'audio', mime_type: 'audio/webm', size_bytes: 1, imported_at: '2026-09-25T12:00:00.000Z', duration_sec: 30, timing_origin_ms: 0, preparation: { status: 'ready', attempts: 1, updated_at: '2026-09-25T12:00:00.000Z' } },
    ] }));
    await saveStoryboard(project.path, { schema_version: 1, project: { id: project.id, name: project.name, created: project.created }, scenes: [{ id: 'scene-01', name: 'Demo', description: 'Demo', type: 'desktop', composition: { version: 1, audio_mix: {}, clips: [{ id: 'clip_source-001', source_asset_id: assetId, source_role: 'screen', source_in_ms: 0, source_out_ms: 30_000, timeline_start_ms: 0, linked_tracks: [{ asset_id: microphoneId, role: 'microphone', source_offset_ms: 0 }] }] }, transcript: { version: 1, source_asset_id: assetId, source_sha256: 'a'.repeat(64), language: 'en', provider: 'gemini', model: 'gemini-test', settings_hash: 'b'.repeat(64), created_at: '2026-09-25T12:00:00.000Z', coverage: [{ start_ms: 0, end_ms: 30_000 }], words: [{ id: 'word_opening1', text: 'Opening', start_ms: 0, end_ms: 1_000 }, { id: 'word_filler001', text: 'um', start_ms: 5_000, end_ms: 5_500 }], passages: [{ id: 'passage_open01', start_ms: 0, end_ms: 12_000, text: 'Opening explanation', word_ids: ['word_opening1', 'word_filler001'] }] } }] });
    app = Fastify();
    await registerAssistanceRoutes(app, { store });
  });

  afterEach(async () => { await app.close(); await rm(home, { recursive: true, force: true }); await rm(projects, { recursive: true, force: true }); });

  it('applies a reviewed trim once and reuses the idempotency result', async () => {
    const inspectionResponse = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/assistance?targetDurationSec=15` });
    expect(inspectionResponse.statusCode, inspectionResponse.body).toBe(200);
    const inspected = inspectionResponse.json();
    const trim = inspected.proposals.find((proposal: { kind: string }) => proposal.kind === 'trim');
    const payload = { expectedRevision: inspected.revision, targetDurationSec: 15, idempotencyKey: 'assist-request-0001' };
    const applied = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/assistance/${trim.id}/apply`, payload });
    expect(applied.statusCode).toBe(200);
    expect((await loadStoryboard(projects + '/assist'))?.scenes[0]?.composition?.clips[0]?.source_out_ms).toBe(12_000);
    const retried = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/assistance/${trim.id}/apply`, payload });
    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toMatchObject({ reused: true });
  });

  it('removes a reviewed filler interval while keeping linked microphone tracks synchronized', async () => {
    const inspection = (await app.inject({ method: 'GET', url: `/api/projects/${projectId}/assistance?targetDurationSec=30` })).json();
    const cleanup = inspection.proposals.find((proposal: { kind: string }) => proposal.kind === 'cleanup');
    const applied = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/assistance/${cleanup.id}/apply`,
      payload: { expectedRevision: inspection.revision, targetDurationSec: 30, idempotencyKey: 'assist-cleanup-0001' },
    });
    expect(applied.statusCode, applied.body).toBe(200);
    const clips = (await loadStoryboard(projects + '/assist'))?.scenes[0]?.composition?.clips ?? [];
    expect(clips.map((clip) => [clip.source_in_ms, clip.source_out_ms])).toEqual([[0, 5_000], [5_500, 30_000]]);
    expect(clips.every((clip) => clip.linked_tracks.some((track) => track.role === 'microphone'))).toBe(true);
  });
});
