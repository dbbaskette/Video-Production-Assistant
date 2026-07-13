import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { ProjectStore } from '../services/project/store.js';
import { saveStoryboard, loadStoryboard } from '../services/storyboard/index.js';
import { __clearFrameManifestCache } from '../services/frame/manifest.js';
import { registerStoryboardRoutes } from './storyboard.js';
import type { Storyboard } from '@vpa/shared';

async function buildTestServer(assetsDir?: string) {
  const home = await mkdtemp(path.join(tmpdir(), 'vpa-sb-routes-'));
  const projects = await mkdtemp(path.join(tmpdir(), 'vpa-sb-projects-'));
  const store = new ProjectStore({ vpaHome: home, projectsDefault: projects });
  const app = Fastify();
  await app.register(async (i) => registerStoryboardRoutes(i, { store, assetsDir }));
  return { app, store, home, projects };
}

/** Build a minimal test assets directory with a 'laptop-flat' frame entry. */
async function buildTestAssetsDir(): Promise<string> {
  const assetsDir = await mkdtemp(path.join(tmpdir(), 'vpa-sb-frames-'));
  const manifest = {
    version: 1,
    frames: [
      {
        id: 'laptop-flat',
        family: 'laptop',
        variant: 'flat',
        displayName: 'MacBook (flat)',
        frame: 'frames/laptop-flat.png',
        thumbnail: 'thumbnails/laptop-flat.png',
        frameSize: { w: 1920, h: 1200 },
        type: 'flat',
        inset: { x: 80, y: 80, w: 1760, h: 1100 },
      },
    ],
  };
  await mkdir(assetsDir, { recursive: true });
  await writeFile(path.join(assetsDir, 'manifest.json'), JSON.stringify(manifest), 'utf-8');
  return assetsDir;
}

function makeSampleStoryboard(projectId: string, projectName: string): Storyboard {
  return {
    schema_version: 1,
    project: {
      id: projectId,
      name: projectName,
      created: new Date().toISOString(),
      objective: 'test objective',
    },
    scenes: [
      {
        id: 'scene-aaa',
        name: 'Intro',
        description: 'Introduction scene',
        type: 'desktop',
      },
      {
        id: 'scene-bbb',
        name: 'Demo',
        description: 'Demo walkthrough',
        type: 'terminal',
      },
    ],
  };
}

describe('storyboard routes', () => {
  let ctx: Awaited<ReturnType<typeof buildTestServer>>;
  let projectId: string;
  let projectPath: string;

  beforeEach(async () => {
    ctx = await buildTestServer();
    const project = await ctx.store.create({ name: 'test-proj', objective: 'testing' });
    projectId = project.id;
    projectPath = project.path;
  });

  afterEach(async () => {
    await ctx.app.close();
    await rm(ctx.home, { recursive: true, force: true });
    await rm(ctx.projects, { recursive: true, force: true });
  });

  it('GET storyboard returns 404 when no storyboard exists', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/storyboard`,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('not_found');
  });

  it('GET storyboard returns it after saving a storyboard file', async () => {
    const sb = makeSampleStoryboard(projectId, 'test-proj');
    await saveStoryboard(projectPath, sb);

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/storyboard`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.schema_version).toBe(1);
    expect(body.scenes).toHaveLength(2);
    expect(body.scenes[0].id).toBe('scene-aaa');
    expect(body.scenes[1].id).toBe('scene-bbb');
  });

  it('POST scene adds a scene to the storyboard', async () => {
    const sb = makeSampleStoryboard(projectId, 'test-proj');
    await saveStoryboard(projectPath, sb);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/storyboard/scenes`,
      payload: { name: 'Outro', description: 'Closing scene', type: 'slide' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.scenes).toHaveLength(3);
    expect(body.scenes[2].name).toBe('Outro');
    expect(body.scenes[2].type).toBe('slide');
    expect(body.scenes[2].id).toBeDefined();
  });

  it('POST scene returns 404 when no storyboard exists', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/storyboard/scenes`,
      payload: { name: 'Orphan', description: 'No storyboard' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('PUT scene updates an existing scene', async () => {
    const sb = makeSampleStoryboard(projectId, 'test-proj');
    await saveStoryboard(projectPath, sb);

    const res = await ctx.app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/storyboard/scenes/scene-aaa`,
      payload: { name: 'Updated Intro', description: 'Updated intro desc' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const scene = body.scenes.find((s: any) => s.id === 'scene-aaa');
    expect(scene.name).toBe('Updated Intro');
    expect(scene.description).toBe('Updated intro desc');
  });

  it('PUT scene returns 404 for nonexistent scene', async () => {
    const sb = makeSampleStoryboard(projectId, 'test-proj');
    await saveStoryboard(projectPath, sb);

    const res = await ctx.app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/storyboard/scenes/no-such-scene`,
      payload: { name: 'Ghost' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('scene_not_found');
  });

  it('DELETE scene removes a scene', async () => {
    const sb = makeSampleStoryboard(projectId, 'test-proj');
    await saveStoryboard(projectPath, sb);

    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/projects/${projectId}/storyboard/scenes/scene-aaa`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.scenes).toHaveLength(1);
    expect(body.scenes[0].id).toBe('scene-bbb');
  });

  it('DELETE scene returns 404 for nonexistent scene', async () => {
    const sb = makeSampleStoryboard(projectId, 'test-proj');
    await saveStoryboard(projectPath, sb);

    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/projects/${projectId}/storyboard/scenes/no-such-scene`,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('scene_not_found');
  });

  it('PUT reorder reorders scenes', async () => {
    const sb = makeSampleStoryboard(projectId, 'test-proj');
    await saveStoryboard(projectPath, sb);

    const res = await ctx.app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/storyboard/reorder`,
      payload: { orderedIds: ['scene-bbb', 'scene-aaa'] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.scenes[0].id).toBe('scene-bbb');
    expect(body.scenes[1].id).toBe('scene-aaa');
  });

  it('PUT reorder returns 400 for invalid input', async () => {
    const sb = makeSampleStoryboard(projectId, 'test-proj');
    await saveStoryboard(projectPath, sb);

    const res = await ctx.app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/storyboard/reorder`,
      payload: { orderedIds: ['scene-aaa'] }, // missing scene-bbb
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('reorder_failed');
  });
});

// ── PUT /api/projects/:id/storyboard/defaults ────────────────────────────────

describe('PUT storyboard defaults (frame fields)', () => {
  let assetsDir: string;
  let ctx: Awaited<ReturnType<typeof buildTestServer>>;
  let projectId: string;
  let projectPath: string;

  beforeEach(async () => {
    __clearFrameManifestCache();
    assetsDir = await buildTestAssetsDir();
    ctx = await buildTestServer(assetsDir);
    const project = await ctx.store.create({ name: 'test-proj', objective: 'testing' });
    projectId = project.id;
    projectPath = project.path;
  });

  afterEach(async () => {
    await ctx.app.close();
    await rm(ctx.home, { recursive: true, force: true });
    await rm(ctx.projects, { recursive: true, force: true });
    await rm(assetsDir, { recursive: true, force: true });
  });

  it('sets frame_style and frame_background; leaves other defaults untouched', async () => {
    const sb: Storyboard = {
      ...makeSampleStoryboard(projectId, 'test-proj'),
      defaults: { brand: 'my-brand', voice_profile: 'vp-1', tts_engine: 'openai' },
    };
    await saveStoryboard(projectPath, sb);

    const res = await ctx.app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/storyboard/defaults`,
      payload: { frame_style: 'laptop-flat', frame_background: 'brand' },
    });
    expect(res.statusCode).toBe(200);

    const saved = await loadStoryboard(projectPath);
    expect(saved?.defaults?.frame_style).toBe('laptop-flat');
    expect(saved?.defaults?.frame_background).toBe('brand');
    // Other defaults NOT touched
    expect(saved?.defaults?.brand).toBe('my-brand');
    expect(saved?.defaults?.voice_profile).toBe('vp-1');
    expect(saved?.defaults?.tts_engine).toBe('openai');
  });

  it('clears frame_style when null is passed', async () => {
    const sb: Storyboard = {
      ...makeSampleStoryboard(projectId, 'test-proj'),
      defaults: { frame_style: 'laptop-flat', brand: 'my-brand' },
    };
    await saveStoryboard(projectPath, sb);

    const res = await ctx.app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/storyboard/defaults`,
      payload: { frame_style: null },
    });
    expect(res.statusCode).toBe(200);

    const saved = await loadStoryboard(projectPath);
    expect(saved?.defaults?.frame_style).toBeUndefined();
    expect(saved?.defaults?.brand).toBe('my-brand');
  });

  it('returns 400 with code invalid_request for an unrecognized frame_background', async () => {
    const sb = makeSampleStoryboard(projectId, 'test-proj');
    await saveStoryboard(projectPath, sb);

    const res = await ctx.app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/storyboard/defaults`,
      payload: { frame_background: 'rainbow' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('invalid_request');
  });

  it('sets and clears tts_expressiveness, leaving other defaults untouched', async () => {
    const sb: Storyboard = {
      ...makeSampleStoryboard(projectId, 'test-proj'),
      defaults: { brand: 'my-brand', frame_style: 'laptop-flat' },
    };
    await saveStoryboard(projectPath, sb);

    // Set
    let res = await ctx.app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/storyboard/defaults`,
      payload: { tts_expressiveness: 'heavy' },
    });
    expect(res.statusCode).toBe(200);
    let saved = await loadStoryboard(projectPath);
    expect(saved?.defaults?.tts_expressiveness).toBe('heavy');
    expect(saved?.defaults?.brand).toBe('my-brand');
    expect(saved?.defaults?.frame_style).toBe('laptop-flat');

    // Clear
    res = await ctx.app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/storyboard/defaults`,
      payload: { tts_expressiveness: null },
    });
    expect(res.statusCode).toBe(200);
    saved = await loadStoryboard(projectPath);
    expect(saved?.defaults?.tts_expressiveness).toBeUndefined();
  });

  it('rejects an invalid tts_expressiveness value', async () => {
    await saveStoryboard(projectPath, makeSampleStoryboard(projectId, 'test-proj'));
    const res = await ctx.app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/storyboard/defaults`,
      payload: { tts_expressiveness: 'extreme' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('invalid_request');
  });

  it('changing only tts_expressiveness does NOT invalidate scene frame_render caches', async () => {
    const sb: Storyboard = {
      ...makeSampleStoryboard(projectId, 'test-proj'),
    };
    // Pretend a scene already has a rendered device-mockup frame cached.
    sb.scenes[0] = { ...sb.scenes[0]!, frame_render: 'frames/scene-01.mp4' };
    await saveStoryboard(projectPath, sb);

    const res = await ctx.app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/storyboard/defaults`,
      payload: { tts_expressiveness: 'light' },
    });
    expect(res.statusCode).toBe(200);

    const saved = await loadStoryboard(projectPath);
    // The frame_render cache reference must survive an unrelated defaults change.
    expect(saved?.scenes[0]?.frame_render).toBe('frames/scene-01.mp4');
  });

  it('returns 400 with code invalid_request for an unknown frame_style', async () => {
    const sb = makeSampleStoryboard(projectId, 'test-proj');
    await saveStoryboard(projectPath, sb);

    const res = await ctx.app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/storyboard/defaults`,
      payload: { frame_style: 'nonexistent-frame' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('invalid_request');
    expect(res.json().error).toMatch(/unknown frame_style/i);
  });

  it('returns 404 when no storyboard exists', async () => {
    const res = await ctx.app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/storyboard/defaults`,
      payload: { frame_style: 'laptop-flat' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('not_found');
  });

  it('PUT defaults clears frame_render on every scene', async () => {
    const sb: Storyboard = {
      ...makeSampleStoryboard(projectId, 'test-proj'),
      scenes: [
        {
          id: 'scene-aaa',
          name: 'Intro',
          description: 'intro',
          type: 'desktop',
          frame_render: 'renders/.frame/scene-aaa-framed.mp4',
        },
        {
          id: 'scene-bbb',
          name: 'Demo',
          description: 'demo',
          type: 'terminal',
          frame_render: 'renders/.frame/scene-bbb-framed.mp4',
        },
      ],
    };
    await saveStoryboard(projectPath, sb);

    const res = await ctx.app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/storyboard/defaults`,
      payload: { frame_style: 'laptop-flat' },
    });
    expect(res.statusCode).toBe(200);

    // Response must not carry any frame_render fields
    const body = res.json();
    for (const scene of body.scenes) {
      expect(scene.frame_render).toBeUndefined();
    }

    // Persisted storyboard must also have frame_render cleared on every scene
    const saved = await loadStoryboard(projectPath);
    for (const scene of saved!.scenes) {
      expect(scene.frame_render).toBeUndefined();
    }
  });

  it('PUT defaults deletes frame_render cache files from disk', async () => {
    const renderRelPathA = 'renders/.frame/scene-aaa-framed.mp4';
    const renderRelPathB = 'renders/.frame/scene-bbb-framed.mp4';
    const renderAbsPathA = path.join(projectPath, renderRelPathA);
    const renderAbsPathB = path.join(projectPath, renderRelPathB);

    await mkdir(path.dirname(renderAbsPathA), { recursive: true });
    await writeFile(renderAbsPathA, 'fake video A', 'utf-8');
    await writeFile(renderAbsPathB, 'fake video B', 'utf-8');

    const sb: Storyboard = {
      ...makeSampleStoryboard(projectId, 'test-proj'),
      scenes: [
        {
          id: 'scene-aaa',
          name: 'Intro',
          description: 'intro',
          type: 'desktop',
          frame_render: renderRelPathA,
        },
        {
          id: 'scene-bbb',
          name: 'Demo',
          description: 'demo',
          type: 'terminal',
          frame_render: renderRelPathB,
        },
      ],
    };
    await saveStoryboard(projectPath, sb);

    const res = await ctx.app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/storyboard/defaults`,
      payload: { frame_style: 'laptop-flat' },
    });
    expect(res.statusCode).toBe(200);

    // Both cache files must be deleted from disk
    const fileAExists = await access(renderAbsPathA).then(() => true).catch(() => false);
    const fileBExists = await access(renderAbsPathB).then(() => true).catch(() => false);
    expect(fileAExists).toBe(false);
    expect(fileBExists).toBe(false);
  });
});

// ── PATCH /api/projects/:id/scenes/:sceneId/frame ────────────────────────────

describe('PATCH scene frame', () => {
  let assetsDir: string;
  let ctx: Awaited<ReturnType<typeof buildTestServer>>;
  let projectId: string;
  let projectPath: string;

  beforeEach(async () => {
    __clearFrameManifestCache();
    assetsDir = await buildTestAssetsDir();
    ctx = await buildTestServer(assetsDir);
    const project = await ctx.store.create({ name: 'test-proj', objective: 'testing' });
    projectId = project.id;
    projectPath = project.path;
  });

  afterEach(async () => {
    await ctx.app.close();
    await rm(ctx.home, { recursive: true, force: true });
    await rm(ctx.projects, { recursive: true, force: true });
    await rm(assetsDir, { recursive: true, force: true });
  });

  it('sets frame_style on the scene and returns the updated scene', async () => {
    const sb = makeSampleStoryboard(projectId, 'test-proj');
    await saveStoryboard(projectPath, sb);

    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/scenes/scene-aaa/frame`,
      payload: { frame_style: 'laptop-flat' },
    });
    expect(res.statusCode).toBe(200);
    const scene = res.json();
    expect(scene.id).toBe('scene-aaa');
    expect(scene.frame_style).toBe('laptop-flat');

    const saved = await loadStoryboard(projectPath);
    expect(saved?.scenes.find((s) => s.id === 'scene-aaa')?.frame_style).toBe('laptop-flat');
  });

  it('clears frame_style when null is passed', async () => {
    const sb: Storyboard = {
      ...makeSampleStoryboard(projectId, 'test-proj'),
      scenes: [
        { id: 'scene-aaa', name: 'Intro', description: 'intro', type: 'desktop', frame_style: 'laptop-flat' },
        { id: 'scene-bbb', name: 'Demo', description: 'demo', type: 'terminal' },
      ],
    };
    await saveStoryboard(projectPath, sb);

    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/scenes/scene-aaa/frame`,
      payload: { frame_style: null },
    });
    expect(res.statusCode).toBe(200);
    const scene = res.json();
    expect(scene.frame_style).toBeUndefined();

    const saved = await loadStoryboard(projectPath);
    expect(saved?.scenes.find((s) => s.id === 'scene-aaa')?.frame_style).toBeUndefined();
  });

  it('deletes the frame_render file and clears it in the storyboard (cache busting)', async () => {
    // Create a fake frame_render file in the project directory
    const renderRelPath = 'renders/.frame/scene-aaa-framed.mp4';
    const renderAbsPath = path.join(projectPath, renderRelPath);
    await mkdir(path.dirname(renderAbsPath), { recursive: true });
    await writeFile(renderAbsPath, 'fake video data', 'utf-8');

    const sb: Storyboard = {
      ...makeSampleStoryboard(projectId, 'test-proj'),
      scenes: [
        {
          id: 'scene-aaa',
          name: 'Intro',
          description: 'intro',
          type: 'desktop',
          frame_style: 'laptop-flat',
          frame_render: renderRelPath,
        },
        { id: 'scene-bbb', name: 'Demo', description: 'demo', type: 'terminal' },
      ],
    };
    await saveStoryboard(projectPath, sb);

    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/scenes/scene-aaa/frame`,
      payload: { frame_style: 'laptop-flat' },
    });
    expect(res.statusCode).toBe(200);

    // frame_render must be cleared in the response
    expect(res.json().frame_render).toBeUndefined();

    // The file must be gone from disk
    const fileExists = await access(renderAbsPath).then(() => true).catch(() => false);
    expect(fileExists).toBe(false);

    // frame_render must be cleared in the persisted storyboard
    const saved = await loadStoryboard(projectPath);
    expect(saved?.scenes.find((s) => s.id === 'scene-aaa')?.frame_render).toBeUndefined();
  });

  it('cache busting is best-effort — no error if frame_render file is missing from disk', async () => {
    const sb: Storyboard = {
      ...makeSampleStoryboard(projectId, 'test-proj'),
      scenes: [
        {
          id: 'scene-aaa',
          name: 'Intro',
          description: 'intro',
          type: 'desktop',
          frame_render: 'renders/.frame/scene-aaa-framed.mp4', // file does not exist
        },
        { id: 'scene-bbb', name: 'Demo', description: 'demo', type: 'terminal' },
      ],
    };
    await saveStoryboard(projectPath, sb);

    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/scenes/scene-aaa/frame`,
      payload: { frame_style: 'laptop-flat' },
    });
    // Should succeed — missing file is ignored
    expect(res.statusCode).toBe(200);
    expect(res.json().frame_render).toBeUndefined();
  });

  it('returns 400 with code invalid_request for an unknown frame_style', async () => {
    const sb = makeSampleStoryboard(projectId, 'test-proj');
    await saveStoryboard(projectPath, sb);

    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/scenes/scene-aaa/frame`,
      payload: { frame_style: 'nonexistent' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('invalid_request');
    expect(res.json().error).toMatch(/unknown frame_style.*nonexistent/i);
  });

  it('returns 400 with code invalid_request for an unrecognized frame_background', async () => {
    const sb = makeSampleStoryboard(projectId, 'test-proj');
    await saveStoryboard(projectPath, sb);

    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/scenes/scene-aaa/frame`,
      payload: { frame_background: 'rainbow' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('invalid_request');
  });

  it('returns 404 for a nonexistent scene', async () => {
    const sb = makeSampleStoryboard(projectId, 'test-proj');
    await saveStoryboard(projectPath, sb);

    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/scenes/no-such-scene/frame`,
      payload: { frame_style: 'laptop-flat' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('scene_not_found');
  });

  it('returns 404 when no storyboard exists', async () => {
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/scenes/scene-aaa/frame`,
      payload: { frame_style: 'laptop-flat' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('not_found');
  });
});
