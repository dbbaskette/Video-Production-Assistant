import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectStore } from '../services/project/store.js';
import { projectFiles } from '../services/project/paths.js';
import { saveStoryboard } from '../services/storyboard/index.js';
import { registerFeedbackRoutes } from './feedback.js';

describe('visual feedback routes', () => {
  let app: ReturnType<typeof Fastify>;
  let home: string;
  let projects: string;
  let projectId: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'vpa-feedback-home-'));
    projects = await mkdtemp(join(tmpdir(), 'vpa-feedback-projects-'));
    const store = new ProjectStore({ vpaHome: home, projectsDefault: projects });
    const project = await store.create({ name: 'feedback' });
    projectId = project.id;
    const assetId = `asset_${'a'.repeat(64)}`;
    const files = projectFiles(project.path);
    await mkdir(files.assetsDir, { recursive: true });
    await writeFile(files.assetManifest, JSON.stringify({ version: 1, assets: [{ id: assetId, checksum: 'a'.repeat(64), original_name: 'demo.mp4', source: '.vpa/assets/originals/demo.mp4', origin: 'source', media_kind: 'video', mime_type: 'video/mp4', size_bytes: 1, imported_at: '2026-09-25T12:00:00.000Z', duration_sec: 10, timing_origin_ms: 0, preparation: { status: 'ready', attempts: 1, updated_at: '2026-09-25T12:00:00.000Z' } }] }));
    await saveStoryboard(project.path, { schema_version: 1, project: { id: project.id, name: project.name, created: project.created }, scenes: [{ id: 'scene-01', name: 'Demo', description: 'Demo', type: 'desktop', composition: { version: 1, audio_mix: {}, clips: [{ id: 'clip_source-001', source_asset_id: assetId, source_role: 'screen', source_in_ms: 0, source_out_ms: 10_000, timeline_start_ms: 0, linked_tracks: [] }] } }] });
    app = Fastify();
    await registerFeedbackRoutes(app, { store });
  });

  afterEach(async () => { await app.close(); await rm(home, { recursive: true, force: true }); await rm(projects, { recursive: true, force: true }); });

  it('persists an anchored note and tracks its resolving revision', async () => {
    const created = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/feedback`, payload: { sceneId: 'scene-01', clipInstanceId: 'clip_source-001', sourceAssetId: `asset_${'a'.repeat(64)}`, sourceInMs: 500, sourceOutMs: 1500, rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }, text: 'Move this callout.' } });
    expect(created.statusCode).toBe(201);
    const noteId = created.json().note.id as string;
    expect((await app.inject({ method: 'POST', url: `/api/projects/${projectId}/feedback/${noteId}/claim`, payload: { actor: 'codex' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/projects/${projectId}/feedback/${noteId}/resolve`, payload: { resolution: 'Moved the callout.' } })).statusCode).toBe(200);
    const list = (await app.inject({ method: 'GET', url: `/api/projects/${projectId}/feedback` })).json();
    expect(list.notes[0]).toMatchObject({ id: noteId, status: 'resolved', resolution: 'Moved the callout.', rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } });
    expect(list.notes[0].resolving_revision).toBeGreaterThan(0);
  });

  it('rejects notes outside the source range', async () => {
    const response = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/feedback`, payload: { sceneId: 'scene-01', clipInstanceId: 'clip_source-001', sourceAssetId: `asset_${'a'.repeat(64)}`, sourceInMs: 9000, sourceOutMs: 11000, text: 'Outside.' } });
    expect(response.statusCode).toBe(400);
  });
});
