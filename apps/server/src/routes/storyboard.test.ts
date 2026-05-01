import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { ProjectStore } from '../services/project/store.js';
import { saveStoryboard } from '../services/storyboard/index.js';
import { registerStoryboardRoutes } from './storyboard.js';
import type { Storyboard } from '@vpa/shared';

async function buildTestServer() {
  const home = await mkdtemp(path.join(tmpdir(), 'vpa-sb-routes-'));
  const projects = await mkdtemp(path.join(tmpdir(), 'vpa-sb-projects-'));
  const store = new ProjectStore({ vpaHome: home, projectsDefault: projects });
  const app = Fastify();
  await app.register(async (i) => registerStoryboardRoutes(i, { store }));
  return { app, store, home, projects };
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
