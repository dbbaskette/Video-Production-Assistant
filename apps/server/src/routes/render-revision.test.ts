import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { OutputVariant, Storyboard } from '@vpa/shared';
import { ProjectStore } from '../services/project/store.js';
import { loadStoryboard, saveStoryboard } from '../services/storyboard/index.js';
import { jobQueue } from '../lib/job-queue.js';
import { registerRenderRoutes } from './render.js';
import { VariantStore } from '../services/variants/store.js';
import { variantDimensions } from '../services/variants/validate.js';

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
  let finalizedVariant: OutputVariant | null = null;
  let store: ProjectStore;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'vpa-render-revision-home-'));
    projects = await mkdtemp(join(tmpdir(), 'vpa-render-revision-projects-'));
    store = new ProjectStore({ vpaHome: home, projectsDefault: projects });
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
    await registerRenderRoutes(app, { store, vpaHome: home, workspaceRoot: process.cwd(), registryFile: join(home, 'brands.json'), renderVideo, finalizeArtifact: async (input, output, _quality, variant) => { finalizedVariant = variant ?? null; await copyFile(input, output); return variant ? variantDimensions(variant.aspect_ratio, '1080p') : { width: 1920, height: 1080 }; } } as Parameters<typeof registerRenderRoutes>[1]);
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

  it('renders a pinned portrait variant to an independent artifact without replacing the base pointer', async () => {
    const project = await store.readProject(projectId);
    await new VariantStore(projectPath).create({
      id: 'variant_portrait-001', name: 'Portrait', aspect_ratio: '9:16', crop: { mode: 'cover', focus_x: 0.5, focus_y: 0.5 }, safe_area: { top: 0.05, right: 0.05, bottom: 0.05, left: 0.05 }, selected_ranges: [], source_language: 'en', target_language: null, captions: [], replace_narration: false, narration_replacement: null,
    }, 0, project);
    const start = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/render`, payload: { variantId: 'variant_portrait-001' } });
    const jobId = start.json().jobId as string;
    await started;
    release();
    for (let attempt = 0; attempt < 100 && jobQueue.get(jobId)?.status === 'running'; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(jobQueue.get(jobId)?.status).toBe('completed');
    expect(finalizedVariant?.id).toBe('variant_portrait-001');
    const status = (await app.inject({ method: 'GET', url: `/api/projects/${projectId}/render/status` })).json();
    expect(status.exists).toBe(false);
    expect(status.artifacts[0]).toMatchObject({ variant: { id: 'variant_portrait-001', aspectRatio: '9:16' }, output: { width: 1080, height: 1920 } });
    await expect(readFile(join(projectPath, 'renders', 'final.mp4'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
