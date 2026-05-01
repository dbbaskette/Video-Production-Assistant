import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { ProjectStore } from '../services/project/store.js';
import { saveStoryboard } from '../services/storyboard/index.js';
import { createFakeLlm } from '../services/llm/index.js';
import { registerQualityReviewRoutes } from './quality-review.js';
import type { Storyboard } from '@vpa/shared';

function workspaceRoot(): string {
  return path.resolve(import.meta.dirname, '../../../..');
}

async function buildTestServer() {
  const home = await mkdtemp(path.join(tmpdir(), 'vpa-qr-routes-'));
  const projects = await mkdtemp(path.join(tmpdir(), 'vpa-qr-projects-'));
  const store = new ProjectStore({ vpaHome: home, projectsDefault: projects });
  const llm = createFakeLlm();

  const app = Fastify();
  await app.register(async (i) =>
    registerQualityReviewRoutes(i, { store, llm, workspaceRoot: workspaceRoot() }),
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
      objective: 'Demo QR',
    },
    scenes: [
      { id: 'scene-01', name: 'Intro', description: 'Introduction', type: 'desktop' },
      { id: 'scene-02', name: 'Setup', description: 'Setting up', type: 'terminal' },
    ],
  };
}

describe('quality review routes', () => {
  let ctx: Awaited<ReturnType<typeof buildTestServer>>;
  let projectId: string;
  let projectPath: string;

  beforeEach(async () => {
    ctx = await buildTestServer();
    const project = await ctx.store.create({ name: 'test-proj', objective: 'Demo QR' });
    projectId = project.id;
    projectPath = project.path;
  });

  afterEach(async () => {
    await ctx.app.close();
    await rm(ctx.home, { recursive: true, force: true });
    await rm(ctx.projects, { recursive: true, force: true });
  });

  it('POST /api/projects/:id/review runs review and returns results', async () => {
    const sb = makeSampleStoryboard(projectId);
    await saveStoryboard(projectPath, sb);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/review`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.summary).toBeDefined();
    expect(body.summary.total).toBeGreaterThan(0);
    expect(['ok', 'warnings', 'issues']).toContain(body.status);
    expect(body.reviewedAt).toBeTruthy();
  });

  it('GET /api/projects/:id/review returns empty before review', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/review`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toEqual([]);
    expect(body.status).toBeNull();
  });

  it('GET /api/projects/:id/review returns cached result after review', async () => {
    const sb = makeSampleStoryboard(projectId);
    await saveStoryboard(projectPath, sb);

    // Run review
    await ctx.app.inject({ method: 'POST', url: `/api/projects/${projectId}/review` });

    // Read back
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/review`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.length).toBeGreaterThan(0);
  });

  it('POST returns 404 when no storyboard exists', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/review`,
    });
    expect(res.statusCode).toBe(404);
  });
});
