import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { ProjectStore } from '../services/project/store.js';
import { saveStoryboard, loadStoryboard } from '../services/storyboard/index.js';
import { createFakeLlm } from '../services/llm/index.js';
import { registerScriptRoutes } from './scripts.js';
import type { Storyboard } from '@vpa/shared';

function workspaceRoot(): string {
  return path.resolve(import.meta.dirname, '../../../..');
}

async function buildTestServer() {
  const home = await mkdtemp(path.join(tmpdir(), 'vpa-script-routes-'));
  const projects = await mkdtemp(path.join(tmpdir(), 'vpa-script-projects-'));
  const store = new ProjectStore({ vpaHome: home, projectsDefault: projects });
  const llm = createFakeLlm();

  const app = Fastify();
  await app.register(async (i) =>
    registerScriptRoutes(i, { store, llm, workspaceRoot: workspaceRoot() }),
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
      objective: 'Demo MCP setup',
    },
    scenes: [
      { id: 'scene-01', name: 'Intro', description: 'Introduction to the demo', type: 'desktop' },
      { id: 'scene-02', name: 'Setup', description: 'Setting up the environment', type: 'terminal' },
    ],
  };
}

describe('script routes', () => {
  let ctx: Awaited<ReturnType<typeof buildTestServer>>;
  let projectId: string;
  let projectPath: string;

  beforeEach(async () => {
    ctx = await buildTestServer();
    const project = await ctx.store.create({ name: 'test-proj', objective: 'Demo MCP setup' });
    projectId = project.id;
    projectPath = project.path;
  });

  afterEach(async () => {
    await ctx.app.close();
    await rm(ctx.home, { recursive: true, force: true });
    await rm(ctx.projects, { recursive: true, force: true });
  });

  it('GET script returns null when no script exists', async () => {
    const sb = makeSampleStoryboard(projectId);
    await saveStoryboard(projectPath, sb);

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/scenes/scene-01/script`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sceneId).toBe('scene-01');
    expect(body.script).toBeNull();
  });

  it('POST generate creates a script and saves it', async () => {
    const sb = makeSampleStoryboard(projectId);
    await saveStoryboard(projectPath, sb);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/script/generate`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sceneId).toBe('scene-01');
    expect(body.script).toBeTruthy();
    expect(body.script).toContain('[');  // emotive tags

    // Verify it was saved to storyboard
    const updated = await loadStoryboard(projectPath);
    const scene = updated!.scenes.find((s) => s.id === 'scene-01');
    expect(scene?.narration?.script).toBe(body.script);
  });

  it('PUT script saves an edited script', async () => {
    const sb = makeSampleStoryboard(projectId);
    await saveStoryboard(projectPath, sb);

    const customScript = '[warm] Welcome to this demo.\n\n[confident] Let me show you how it works.';
    const res = await ctx.app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/scenes/scene-01/script`,
      payload: { script: customScript },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().script).toBe(customScript);

    // Verify saved
    const updated = await loadStoryboard(projectPath);
    const scene = updated!.scenes.find((s) => s.id === 'scene-01');
    expect(scene?.narration?.script).toBe(customScript);
  });

  it('PUT script returns 400 without script field', async () => {
    const sb = makeSampleStoryboard(projectId);
    await saveStoryboard(projectPath, sb);

    const res = await ctx.app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/scenes/scene-01/script`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('invalid_request');
  });

  it('returns 404 for non-existent scene', async () => {
    const sb = makeSampleStoryboard(projectId);
    await saveStoryboard(projectPath, sb);

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/scenes/no-such/script`,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('scene_not_found');
  });

  it('returns 404 when no storyboard exists', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/script/generate`,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('not_found');
  });

  it('GET script reflects previously generated script', async () => {
    const sb = makeSampleStoryboard(projectId);
    await saveStoryboard(projectPath, sb);

    // Generate
    await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/script/generate`,
    });

    // Read back
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/scenes/scene-01/script`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().script).toBeTruthy();
  });
});
