import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Storyboard } from '@vpa/shared';
import { ProjectStore } from '../services/project/store.js';
import { saveStoryboard } from '../services/storyboard/index.js';
import { jobQueue } from '../lib/job-queue.js';
import { registerRenderRoutes } from './render.js';
// The generic /api/jobs/:jobId/cancel endpoint is registered by the narration
// routes module, so the test mounts it alongside the render routes.
import { registerNarrationRoutes } from './narration.js';

describe('full render cooperative cancellation', () => {
  let app: ReturnType<typeof Fastify>;
  let home: string;
  let projects: string;
  let projectId: string;
  let projectPath: string;
  /** Flipped when the pipeline's isCancelled poll first returns true. */
  let observedCancelling: boolean;

  beforeEach(async () => {
    observedCancelling = false;
    home = await mkdtemp(join(tmpdir(), 'vpa-render-cancel-home-'));
    projects = await mkdtemp(join(tmpdir(), 'vpa-render-cancel-projects-'));
    const store = new ProjectStore({ vpaHome: home, projectsDefault: projects });
    const project = await store.create({ name: 'render-cancel' });
    projectId = project.id;
    projectPath = project.path;
    await mkdir(join(projectPath, 'recordings'), { recursive: true });
    await writeFile(join(projectPath, 'recordings', 'video.mp4'), 'not-real-video');
    const storyboard: Storyboard = {
      schema_version: 1,
      project: { id: project.id, name: project.name, created: project.created },
      scenes: [{
        id: 'scene-01',
        name: 'Video',
        description: 'A recording.',
        type: 'desktop',
        recording: { source: 'recordings/video.mp4', duration_sec: 30 },
      }],
    };
    await saveStoryboard(projectPath, storyboard);

    // Stands in for the ffmpeg pipeline: waits until cancellation is
    // observable (proving the isCancelled poll is wired through), then throws
    // the way renderFinalVideo does on a cancelled boundary.
    const renderVideo = async (
      _path: string,
      opts: { isCancelled?: () => boolean },
    ) => {
      for (let attempt = 0; attempt < 500 && !opts.isCancelled?.(); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (opts.isCancelled?.()) {
        observedCancelling = true;
        throw new Error('Render cancelled');
      }
      return { outputPath: join(projectPath, 'renders', 'final.mp4'), scenePaths: [], durationSec: 1 };
    };

    app = Fastify();
    await app.register(async (i: ReturnType<typeof Fastify>) =>
      registerNarrationRoutes(i, {
        store,
        tts: {} as never,
        router: {} as never,
        workspaceRoot: process.cwd(),
        vpaHome: home,
      }),
    );
    await registerRenderRoutes(app, {
      store,
      vpaHome: home,
      workspaceRoot: process.cwd(),
      registryFile: join(home, 'brands.json'),
      renderVideo,
    } as Parameters<typeof registerRenderRoutes>[1]);
  });

  afterEach(async () => {
    await app?.close();
    await rm(home, { recursive: true, force: true });
    await rm(projects, { recursive: true, force: true });
  });

  it('marks a cancelled running render as cancelled with a bounded result', async () => {
    const start = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/render`,
      payload: {},
    });
    expect(start.statusCode).toBe(200);
    const jobId = start.json().jobId as string;
    expect(jobQueue.get(jobId)?.status).toBe('running');

    const cancel = await app.inject({ method: 'POST', url: `/api/jobs/${jobId}/cancel` });
    expect(cancel.json()).toMatchObject({ cancelled: true, status: 'cancelling' });
    expect(jobQueue.get(jobId)?.status).toBe('cancelling');

    for (let attempt = 0; attempt < 100 && jobQueue.get(jobId)?.status === 'cancelling'; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(observedCancelling).toBe(true);
    const job = jobQueue.get(jobId)!;
    expect(job.status).toBe('cancelled');
    expect(job.result).toMatchObject({ projectId, cancelled: true });
  });

  it('reports already-terminal jobs as not cancellable', async () => {
    const start = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/render`,
      payload: {},
    });
    const jobId = start.json().jobId as string;
    await app.inject({ method: 'POST', url: `/api/jobs/${jobId}/cancel` });
    for (let attempt = 0; attempt < 100 && jobQueue.get(jobId)?.status === 'cancelling'; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const again = await app.inject({ method: 'POST', url: `/api/jobs/${jobId}/cancel` });
    expect(again.json()).toEqual({ cancelled: false, status: 'cancelled' });
  });
});
