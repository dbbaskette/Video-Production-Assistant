import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import FormData from 'form-data';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../services/project/store.js';
import { registerAssetRoutes } from './assets.js';
import { registerCommandRoutes } from './commands.js';
import { saveStoryboard, loadStoryboard } from '../services/storyboard/index.js';
import { projectFiles } from '../services/project/paths.js';
import { AssetStore } from '../services/assets/store.js';

async function buildFixture() {
  const home = await mkdtemp(path.join(tmpdir(), 'vpa-foundation-home-'));
  const projects = await mkdtemp(path.join(tmpdir(), 'vpa-foundation-projects-'));
  const store = new ProjectStore({ vpaHome: home, projectsDefault: projects });
  const project = await store.create({ name: 'foundation-test' });
  await saveStoryboard(project.path, {
    schema_version: 1,
    project: { id: project.id, name: project.name, created: project.created },
    scenes: [
      { id: 'scene-01', name: 'First', description: 'First scene', type: 'desktop' },
      { id: 'scene-02', name: 'Second', description: 'Second scene', type: 'desktop' },
    ],
  });
  const app = Fastify();
  await app.register(multipart, { limits: { fileSize: 2 * 1024 ** 3, files: 100 } });
  await app.register(async (instance) => registerAssetRoutes(instance, {
    store,
    createAssetStore: (root) => new AssetStore(root, {
      probe: async () => ({ duration_sec: 12, width: 1920, height: 1080, codec: 'h264', fps: 30, size_bytes: 32 }),
    }),
  }));
  await app.register(async (instance) => registerCommandRoutes(instance, { store }));
  return { app, home, projects, project };
}

describe('foundation asset and command routes', () => {
  let fixture: Awaited<ReturnType<typeof buildFixture>>;
  beforeEach(async () => { fixture = await buildFixture(); });
  afterEach(async () => {
    await fixture.app.close();
    await rm(fixture.home, { recursive: true, force: true });
    await rm(fixture.projects, { recursive: true, force: true });
  });

  it('imports, previews, reviews, and atomically assigns source assets', async () => {
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
    const form = new FormData();
    form.append('file', png, { filename: 'slide.png', contentType: 'image/png' });
    const imported = await fixture.app.inject({
      method: 'POST',
      url: `/api/projects/${fixture.project.id}/assets/import`,
      payload: form.getBuffer(),
      headers: form.getHeaders(),
    });
    expect(imported.statusCode).toBe(201);
    const asset = imported.json().assets[0];
    expect(asset).toMatchObject({ media_kind: 'image', original_name: 'slide.png', preparation: { status: 'ready' } });

    const content = await fixture.app.inject({
      method: 'GET',
      url: `/api/projects/${fixture.project.id}/assets/${asset.id}/content`,
    });
    expect(content.statusCode).toBe(200);
    expect(content.rawPayload).toEqual(png);

    const mapped = await fixture.app.inject({
      method: 'POST',
      url: `/api/projects/${fixture.project.id}/assets/mappings`,
      payload: {
        expectedRevision: 0,
        idempotencyKey: 'mapping-0001',
        mappings: [{ assetId: asset.id, sceneId: 'scene-02', role: 'image', timingOriginMs: 0 }],
      },
    });
    expect(mapped.statusCode).toBe(200);
    expect(mapped.json().result.revision).toBe(1);
    expect((await loadStoryboard(fixture.project.path))?.scenes[1]?.sources).toContainEqual({
      asset_id: asset.id,
      role: 'image',
      timing_origin_ms: 0,
    });
  });

  it('rejects stale command writers and keeps the current document unchanged', async () => {
    const first = await fixture.app.inject({
      method: 'POST',
      url: `/api/projects/${fixture.project.id}/commands`,
      payload: { expectedRevision: 0, idempotencyKey: 'project-0001', commands: [{ type: 'project.patch', patch: { objective: 'First' } }] },
    });
    expect(first.statusCode).toBe(200);
    const stale = await fixture.app.inject({
      method: 'POST',
      url: `/api/projects/${fixture.project.id}/commands`,
      payload: { expectedRevision: 0, idempotencyKey: 'project-0002', commands: [{ type: 'project.patch', patch: { objective: 'Stale' } }] },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'stale_revision', currentRevision: 1 });
    expect(await readFile(projectFiles(fixture.project.path).metadata, 'utf8')).toContain('objective: First');
  });

  it('migrates legacy recording references without deleting their bytes', async () => {
    const legacyRelative = 'recordings/scene-01.mp4';
    const legacyAbsolute = path.join(fixture.project.path, legacyRelative);
    await mkdir(path.dirname(legacyAbsolute), { recursive: true });
    const bytes = Buffer.concat([Buffer.alloc(4), Buffer.from('ftyp'), Buffer.alloc(24)]);
    await writeFile(legacyAbsolute, bytes);
    const storyboard = (await loadStoryboard(fixture.project.path))!;
    storyboard.scenes[0]!.recording = { source: legacyRelative, duration_sec: 12 };
    await saveStoryboard(fixture.project.path, storyboard);

    const response = await fixture.app.inject({
      method: 'GET',
      url: `/api/projects/${fixture.project.id}/assets`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().migrationWarnings).toEqual([]);
    const migrated = (await loadStoryboard(fixture.project.path))!.scenes[0]!.recording!;
    expect(migrated.asset_id).toMatch(/^asset_[a-f0-9]{64}$/);
    expect(migrated.source).toMatch(/^\.vpa\/assets\/originals\/[a-f0-9]{64}\.mp4$/);
    expect(await readFile(legacyAbsolute)).toEqual(bytes);
  });
});
