import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { ProjectStore } from '../services/project/store.js';
import { saveStoryboard } from '../services/storyboard/index.js';
import { createFakeLlm, type LlmClient } from '../services/llm/index.js';
import { ModelRoutingError, type ModelRouter } from '../services/llm/model-router.js';
import { registerQualityReviewRoutes } from './quality-review.js';
import type { Storyboard } from '@vpa/shared';

function workspaceRoot(): string {
  return path.resolve(import.meta.dirname, '../../../..');
}

async function buildTestServer(general: LlmClient = createFakeLlm()) {
  const home = await mkdtemp(path.join(tmpdir(), 'vpa-qr-routes-'));
  const projects = await mkdtemp(path.join(tmpdir(), 'vpa-qr-projects-'));
  const store = new ProjectStore({ vpaHome: home, projectsDefault: projects });
  const resolveText = vi.fn(async () => ({
    client: general,
    summary: {
      role: 'general' as const,
      scope: 'project' as const,
      entry_id: 'general-model',
      provider: 'fake' as const,
      model: 'fake-general',
      name: 'General',
      capabilities: { text: true, image: false, video: false },
      ready: true as const,
    },
  }));
  const router = { resolveText } as unknown as ModelRouter;

  const app = Fastify();
  await app.register(async (i) =>
    registerQualityReviewRoutes(i, { store, router, workspaceRoot: workspaceRoot() }),
  );
  return { app, store, general, resolveText, home, projects };
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
    expect(ctx.resolveText).toHaveBeenCalledWith(
      'general',
      expect.objectContaining({ id: projectId }),
    );
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

  it('preserves the cached review when general routing fails', async () => {
    await saveStoryboard(projectPath, makeSampleStoryboard(projectId));
    const initial = await ctx.app.inject({ method: 'POST', url: `/api/projects/${projectId}/review` });
    expect(initial.statusCode).toBe(200);
    ctx.resolveText.mockRejectedValueOnce(new ModelRoutingError(
      'model_unavailable',
      'general',
      'project',
      'The assigned general model is unavailable.',
      503,
    ));

    const failed = await ctx.app.inject({ method: 'POST', url: `/api/projects/${projectId}/review` });
    expect(failed.statusCode).toBe(503);
    expect(failed.json()).toMatchObject({ code: 'model_unavailable', role: 'general' });

    const cached = await ctx.app.inject({ method: 'GET', url: `/api/projects/${projectId}/review` });
    expect(cached.json()).toEqual(initial.json());
  });

  it('bounds provider diagnostics and does not cache a failed review', async () => {
    const failingGeneral: LlmClient = {
      async complete() {
        throw new Error('private provider diagnostic');
      },
    };
    await ctx.app.close();
    await rm(ctx.home, { recursive: true, force: true });
    await rm(ctx.projects, { recursive: true, force: true });
    ctx = await buildTestServer(failingGeneral);
    const project = await ctx.store.create({ name: 'failed-review' });
    await saveStoryboard(project.path, makeSampleStoryboard(project.id));

    const failed = await ctx.app.inject({ method: 'POST', url: `/api/projects/${project.id}/review` });
    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toEqual({
      error: 'Quality review failed. Your previous review was not changed.',
      code: 'quality_review_failed',
    });
    expect(JSON.stringify(failed.json())).not.toContain('private provider diagnostic');
  });
});
