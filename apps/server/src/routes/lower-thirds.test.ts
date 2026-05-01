import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { ProjectStore } from '../services/project/store.js';
import { saveStoryboard, loadStoryboard } from '../services/storyboard/index.js';
import { createFakeLlm } from '../services/llm/index.js';
import { registerLowerThirdsRoutes } from './lower-thirds.js';
import type { Storyboard } from '@vpa/shared';

function workspaceRoot(): string {
  return path.resolve(import.meta.dirname, '../../../..');
}

async function buildTestServer() {
  const home = await mkdtemp(path.join(tmpdir(), 'vpa-lt-routes-'));
  const projects = await mkdtemp(path.join(tmpdir(), 'vpa-lt-projects-'));
  const store = new ProjectStore({ vpaHome: home, projectsDefault: projects });
  const llm = createFakeLlm();

  const app = Fastify();
  await app.register(async (i) =>
    registerLowerThirdsRoutes(i, { store, llm, workspaceRoot: workspaceRoot() }),
  );
  return { app, store, llm, home, projects };
}

function makeSampleStoryboard(projectId: string): Storyboard {
  return {
    schema_version: 1,
    project: {
      id: projectId,
      name: 'test-proj',
      created: new Date().toISOString(),
      objective: 'Demo LT',
    },
    scenes: [
      { id: 'scene-01', name: 'Intro', description: 'Introduction to the demo', type: 'desktop' },
      { id: 'scene-02', name: 'Setup', description: 'Setting up', type: 'terminal' },
    ],
  };
}

describe('lower-thirds routes', () => {
  let ctx: Awaited<ReturnType<typeof buildTestServer>>;
  let projectId: string;
  let projectPath: string;

  beforeEach(async () => {
    ctx = await buildTestServer();
    const project = await ctx.store.create({ name: 'test-proj', objective: 'Demo LT' });
    projectId = project.id;
    projectPath = project.path;
  });

  afterEach(async () => {
    await ctx.app.close();
    await rm(ctx.home, { recursive: true, force: true });
    await rm(ctx.projects, { recursive: true, force: true });
  });

  it('GET returns empty array when no lower thirds exist', async () => {
    const sb = makeSampleStoryboard(projectId);
    await saveStoryboard(projectPath, sb);

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/scenes/scene-01/lower-thirds`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sceneId).toBe('scene-01');
    expect(body.lowerThirds).toEqual([]);
  });

  it('POST recommend generates lower thirds and saves them', async () => {
    const sb = makeSampleStoryboard(projectId);
    await saveStoryboard(projectPath, sb);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/lower-thirds/recommend`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sceneId).toBe('scene-01');
    expect(body.lowerThirds.length).toBeGreaterThan(0);
    expect(body.lowerThirds[0]).toHaveProperty('title');
    expect(body.lowerThirds[0]).toHaveProperty('in_sec');
    expect(body.lowerThirds[0]).toHaveProperty('out_sec');

    // Verify saved in storyboard
    const updated = await loadStoryboard(projectPath);
    const scene = updated!.scenes.find((s) => s.id === 'scene-01');
    expect(scene?.lower_thirds?.length).toBeGreaterThan(0);
  });

  it('PUT saves edited lower thirds', async () => {
    const sb = makeSampleStoryboard(projectId);
    await saveStoryboard(projectPath, sb);

    const customLTs = [
      { title: 'Custom Title', subtitle: 'Custom Sub', style: 'solid' as const, in_sec: 2.0, out_sec: 7.0 },
    ];
    const res = await ctx.app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/scenes/scene-01/lower-thirds`,
      payload: { lowerThirds: customLTs },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().lowerThirds[0].title).toBe('Custom Title');

    // Verify saved
    const updated = await loadStoryboard(projectPath);
    const scene = updated!.scenes.find((s) => s.id === 'scene-01');
    expect(scene?.lower_thirds?.[0]?.title).toBe('Custom Title');
  });

  it('PUT returns 400 without lowerThirds array', async () => {
    const sb = makeSampleStoryboard(projectId);
    await saveStoryboard(projectPath, sb);

    const res = await ctx.app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/scenes/scene-01/lower-thirds`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 for nonexistent scene', async () => {
    const sb = makeSampleStoryboard(projectId);
    await saveStoryboard(projectPath, sb);

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/scenes/no-such/lower-thirds`,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('scene_not_found');
  });

  it('returns 404 when no storyboard exists', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/lower-thirds/recommend`,
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET reflects previously recommended lower thirds', async () => {
    const sb = makeSampleStoryboard(projectId);
    await saveStoryboard(projectPath, sb);

    // Recommend
    await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/lower-thirds/recommend`,
    });

    // Read back
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/scenes/scene-01/lower-thirds`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().lowerThirds.length).toBeGreaterThan(0);
  });
});
