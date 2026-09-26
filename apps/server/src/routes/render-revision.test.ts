import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Storyboard } from '@vpa/shared';
import { ProjectStore } from '../services/project/store.js';
import { loadStoryboard, saveStoryboard } from '../services/storyboard/index.js';
import { jobQueue } from '../lib/job-queue.js';
import { registerRenderRoutes } from './render.js';

describe('revision-correct render artifacts', () => {
  let app: ReturnType<typeof Fastify>;
  let home: string;
  let projects: string;
  let projectId: string;
  let projectPath: string;
  let release!: () => void;
  let started!: Promise<void>;
  let resolveStarted!: () => void;
  let renderedDescription = '';

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'vpa-render-revision-home-'));
    projects = await mkdtemp(join(tmpdir(), 'vpa-render-revision-projects-'));
    const store = new ProjectStore({ vpaHome: home, projectsDefault: projects });
    const project = await store.create({ name: 'render-revision' });
    projectId = project.id;
    projectPath = project.path;
    await mkdir(join(projectPath, 'recordings'), { recursive: true });
    await writeFile(join(projectPath, 'recordings', 'video.mp4'), 'source');
    const storyboard: Storyboard = { schema_version: 1, project: { id: project.id, name: project.name, created: project.created }, scenes: [{ id: 'scene-01', name: 'Video', description: 'Revision zero', type: 'desktop', recording: { source: 'recordings/video.mp4', duration_sec: 3 } }] };
    await saveStoryboard(projectPath, storyboard);
    started = new Promise<void>((resolve) => { resolveStarted = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const renderVideo = async (snapshotPath: string) => {
      renderedDescription = (await loadStoryboard(snapshotPath))!.scenes[0]!.description;
      resolveStarted();
      await gate;
      const outputPath = join(snapshotPath, 'renders', 'final.mp4');
      await mkdir(join(snapshotPath, 'renders'), { recursive: true });
      await writeFile(outputPath, 'rendered-revision-zero');
      return { outputPath, scenePaths: [outputPath], durationSec: 3 };
    };
    app = Fastify();
    await registerRenderRoutes(app, { store, vpaHome: home, workspaceRoot: process.cwd(), registryFile: join(home, 'brands.json'), renderVideo, finalizeArtifact: async (input, output) => { await copyFile(input, output); return { width: 1920, height: 1080 }; } } as Parameters<typeof registerRenderRoutes>[1]);
  });

  afterEach(async () => { release?.(); await app.close(); await rm(home, { recursive: true, force: true }); await rm(projects, { recursive: true, force: true }); });

  it('keeps submitted inputs immutable and reports later edits as stale', async () => {
    const start = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/render`, payload: {} });
    const jobId = start.json().jobId as string;
    await started;
    const current = (await loadStoryboard(projectPath))!;
    current.scenes[0]!.description = 'Edited during render';
    await saveStoryboard(projectPath, current);
    release();
    for (let attempt = 0; attempt < 100 && jobQueue.get(jobId)?.status === 'running'; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(jobQueue.get(jobId)?.status).toBe('completed');
    expect(renderedDescription).toBe('Revision zero');
    const status = (await app.inject({ method: 'GET', url: `/api/projects/${projectId}/render/status` })).json();
    expect(status).toMatchObject({ exists: true, stale: true, currentRevision: 1, manifest: { revision: 0, output: { width: 1920, height: 1080, videoCodec: 'h264', audioCodec: 'aac' } } });
    expect(await readFile(join(projectPath, status.manifest.output.path), 'utf8')).toBe('rendered-revision-zero');
  });
});
