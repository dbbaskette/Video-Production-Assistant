import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectStore } from '../services/project/store.js';
import { RenderError } from '../services/render/index.js';
import { registerSceneRenderRoutes } from './scene-render.js';

describe('scene render failure boundary', () => {
  let app: ReturnType<typeof Fastify>;
  let home: string;
  let projects: string;
  let projectId: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'vpa-scene-render-route-home-'));
    projects = await mkdtemp(join(tmpdir(), 'vpa-scene-render-route-projects-'));
    const store = new ProjectStore({ vpaHome: home, projectsDefault: projects });
    projectId = (await store.create({ name: 'render-boundary' })).id;
    const renderScene = vi.fn(async () => {
      throw new RenderError(
        `Command failed: ffmpeg -i ${projects}/private.mp4 --token private-token`,
        { stderrTail: `Invalid data in ${projects}/private.mp4` },
      );
    });
    app = Fastify();
    await registerSceneRenderRoutes(app, {
      store,
      vpaHome: home,
      workspaceRoot: process.cwd(),
      renderScene,
    } as Parameters<typeof registerSceneRenderRoutes>[1]);
  });

  afterEach(async () => {
    await app?.close();
    await rm(home, { recursive: true, force: true });
    await rm(projects, { recursive: true, force: true });
  });

  it('does not return raw process diagnostics to scene-render clients', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-private/render`,
      payload: {},
    });
    const serialized = response.body;

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: 'Scene rendering failed. Check the source media and try again.',
      code: 'scene_render_failed',
    });
    expect(serialized).not.toContain('ffmpeg');
    expect(serialized).not.toContain(projects);
    expect(serialized).not.toContain('private-token');
    expect(serialized).not.toContain('stderrTail');
  });
});
