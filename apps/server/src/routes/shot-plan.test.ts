import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { ProjectStore } from '../services/project/store.js';
import { ShotPlanManager } from '../services/shot-plan/index.js';
import { createFakeLlm } from '../services/llm/index.js';
import type { LlmClient } from '../services/llm/index.js';
import { saveStoryboard, createStoryboard, loadStoryboard } from '../services/storyboard/index.js';
import { registerShotPlanRoutes } from './shot-plan.js';

async function buildTestServer(opts: { llm?: LlmClient } = {}) {
  const home = await mkdtemp(path.join(tmpdir(), 'vpa-sp-home-'));
  const projects = await mkdtemp(path.join(tmpdir(), 'vpa-sp-projects-'));
  const store = new ProjectStore({ vpaHome: home, projectsDefault: projects });
  const llm = opts.llm ?? createFakeLlm();
  const shotPlanManager = new ShotPlanManager();
  const app = Fastify();
  await app.register(async (i) =>
    registerShotPlanRoutes(i, { store, llm, shotPlanManager }),
  );
  return { app, store, llm, shotPlanManager, home, projects };
}

async function seedProjectWithScene(
  store: ProjectStore,
  sceneId = 'scene-01',
): Promise<{ projectId: string; projectPath: string }> {
  const project = await store.create({ name: 'sp-test', objective: 'test demo' });
  const tracker = await store.readTracker();
  const entry = tracker.projects.find((p) => p.id === project.id)!;
  const sb = createStoryboard(
    {
      id: entry.id,
      name: entry.name,
      path: entry.path,
      created: entry.lastOpened ?? new Date().toISOString(),
      brand: null,
    },
    [
      {
        id: sceneId,
        name: 'Boot the dev server',
        description: 'Show npm run dev starting',
        type: 'terminal',
      },
    ],
  );
  await saveStoryboard(entry.path, sb);
  return { projectId: project.id, projectPath: entry.path };
}

describe('shot-plan routes', () => {
  let ctx: Awaited<ReturnType<typeof buildTestServer>>;

  beforeEach(async () => {
    ctx = await buildTestServer();
  });

  afterEach(async () => {
    await ctx.app.close();
    await rm(ctx.home, { recursive: true, force: true });
    await rm(ctx.projects, { recursive: true, force: true });
  });

  it('GET returns empty state for a fresh scene', async () => {
    const { projectId } = await seedProjectWithScene(ctx.store);
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/scenes/scene-01/shot-plan`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.transcript).toEqual([]);
    expect(body.proposedSteps).toEqual([]);
    expect(body.savedPlan).toBeNull();
  });

  it('POST /message returns assistant reply with proposed steps', async () => {
    const { projectId } = await seedProjectWithScene(ctx.store);
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/shot-plan/message`,
      payload: { content: 'Plan it' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.reply).toBeTruthy();
    expect(body.reply).not.toContain('```json');
    expect(body.proposedSteps.length).toBeGreaterThan(0);
    expect(body.proposedSteps[0].action).toBeTruthy();
  });

  it('GET after a message includes transcript and proposed steps from memory', async () => {
    const { projectId } = await seedProjectWithScene(ctx.store);
    await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/shot-plan/message`,
      payload: { content: 'Plan it' },
    });
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/scenes/scene-01/shot-plan`,
    });
    const body = res.json();
    expect(body.transcript).toHaveLength(2);
    expect(body.proposedSteps.length).toBeGreaterThan(0);
    expect(body.savedPlan).toBeNull();
  });

  it('POST /accept persists plan + transcript to storyboard.yaml', async () => {
    const { projectId, projectPath } = await seedProjectWithScene(ctx.store);
    await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/shot-plan/message`,
      payload: { content: 'Plan it' },
    });
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/shot-plan/accept`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.shot_plan.length).toBeGreaterThan(0);
    expect(body.shot_plan_chat.length).toBe(2);

    const sb = await loadStoryboard(projectPath);
    const scene = sb!.scenes.find((s) => s.id === 'scene-01')!;
    expect(scene.shot_plan?.length).toBe(body.shot_plan.length);
    expect(scene.shot_plan_chat?.length).toBe(2);

    // accept clears the in-memory session
    expect(ctx.shotPlanManager.get(projectId, 'scene-01')).toBeUndefined();
  });

  it('POST /accept returns 400 when no proposedSteps exist', async () => {
    const { projectId } = await seedProjectWithScene(ctx.store);
    // Touching GET creates an empty session — accept must still 400.
    await ctx.app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/scenes/scene-01/shot-plan`,
    });
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/shot-plan/accept`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('no_steps');
  });

  it('DELETE clears persisted shot_plan and shot_plan_chat and the in-memory session', async () => {
    const { projectId, projectPath } = await seedProjectWithScene(ctx.store);
    await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/shot-plan/message`,
      payload: { content: 'Plan it' },
    });
    await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/shot-plan/accept`,
    });
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/projects/${projectId}/scenes/scene-01/shot-plan`,
    });
    expect(res.statusCode).toBe(200);
    const sb = await loadStoryboard(projectPath);
    const scene = sb!.scenes.find((s) => s.id === 'scene-01')!;
    expect(scene.shot_plan).toBeUndefined();
    expect(scene.shot_plan_chat).toBeUndefined();
    expect(ctx.shotPlanManager.get(projectId, 'scene-01')).toBeUndefined();
  });

  it('POST /evict drops only the in-memory session, never touches disk', async () => {
    const { projectId, projectPath } = await seedProjectWithScene(ctx.store);
    await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/shot-plan/message`,
      payload: { content: 'Plan it' },
    });
    await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/shot-plan/accept`,
    });
    // start a Refine: GET to hydrate, then send a message
    await ctx.app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/scenes/scene-01/shot-plan`,
    });
    await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/shot-plan/message`,
      payload: { content: 'tighten it up' },
    });
    expect(ctx.shotPlanManager.get(projectId, 'scene-01')).toBeDefined();

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/shot-plan/evict`,
    });
    expect(res.statusCode).toBe(200);
    expect(ctx.shotPlanManager.get(projectId, 'scene-01')).toBeUndefined();

    // disk still has the previously accepted plan
    const sb = await loadStoryboard(projectPath);
    const scene = sb!.scenes.find((s) => s.id === 'scene-01')!;
    expect(scene.shot_plan?.length).toBeGreaterThan(0);
  });

  it('POST /message with empty content returns 400', async () => {
    const { projectId } = await seedProjectWithScene(ctx.store);
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/shot-plan/message`,
      payload: { content: '' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('invalid_request');
  });

  it('returns 404 for an unknown project', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/projects/does-not-exist/scenes/scene-01/shot-plan`,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('project_not_found');
  });

  it('returns 404 for an unknown scene', async () => {
    const { projectId } = await seedProjectWithScene(ctx.store);
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/scenes/unknown/shot-plan`,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('scene_not_found');
  });

  it('returns 502 with code llm_error when the LLM throws', async () => {
    // Tear down the default-context server and build a fresh one with a throwing LLM
    // so we don't pollute the other tests.
    await ctx.app.close();
    await rm(ctx.home, { recursive: true, force: true });
    await rm(ctx.projects, { recursive: true, force: true });
    const throwingLlm: LlmClient = {
      async complete() {
        throw new Error('upstream is down');
      },
    };
    ctx = await buildTestServer({ llm: throwingLlm });
    const { projectId } = await seedProjectWithScene(ctx.store);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/shot-plan/message`,
      payload: { content: 'Plan it' },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().code).toBe('llm_error');
  });
});
