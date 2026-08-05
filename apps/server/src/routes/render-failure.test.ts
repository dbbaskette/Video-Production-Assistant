import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Storyboard } from '@vpa/shared';
import { ProjectStore } from '../services/project/store.js';
import { saveStoryboard } from '../services/storyboard/index.js';
import { RenderError } from '../services/render/index.js';
import { jobQueue } from '../lib/job-queue.js';
import { registerRenderRoutes } from './render.js';

describe('full render job failure boundary', () => {
  let app: ReturnType<typeof Fastify>;
  let home: string;
  let projects: string;
  let projectId: string;
  let projectPath: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'vpa-render-route-home-'));
    projects = await mkdtemp(join(tmpdir(), 'vpa-render-route-projects-'));
    const store = new ProjectStore({ vpaHome: home, projectsDefault: projects });
    const project = await store.create({ name: 'render-boundary' });
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
    const renderVideo = async () => {
      throw new RenderError(
        `Command failed: ffmpeg -i ${projectPath}/recordings/video.mp4 --token private-token`,
        { stderrTail: `Invalid data in ${projectPath}/recordings/video.mp4` },
      );
    };
    app = Fastify();
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

  it('stores only a stable bounded public failure in render job state', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/render`,
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    const jobId = response.json().jobId as string;

    for (let attempt = 0; attempt < 50 && jobQueue.get(jobId)?.status === 'running'; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const job = jobQueue.get(jobId)!;
    const serialized = JSON.stringify(job);

    expect(job.status).toBe('failed');
    expect(job.error).toBe(
      'render_failed: Video rendering failed. Check the source media and try again.',
    );
    expect(serialized).not.toContain('ffmpeg');
    expect(serialized).not.toContain(projectPath);
    expect(serialized).not.toContain('private-token');
    expect(serialized).not.toContain('Invalid data');
  });
});
