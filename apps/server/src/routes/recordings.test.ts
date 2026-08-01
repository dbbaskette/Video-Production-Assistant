import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import FormData from 'form-data';
import { ProjectStore } from '../services/project/store.js';
import { saveStoryboard } from '../services/storyboard/index.js';
import { createFakeLlm } from '../services/llm/index.js';
import { createFakeProbe } from '../services/recording/metadata.js';
import { registerRecordingRoutes } from './recordings.js';
import type { Storyboard } from '@vpa/shared';
import { loadStoryboard } from '../services/storyboard/index.js';
import { ingestRecording } from '../services/recording/ingest.js';
import { createAgentRecordingSession } from '../services/agent-recording/session.js';

function workspaceRoot(): string {
  return path.resolve(import.meta.dirname, '../../../..');
}

async function buildTestServer() {
  const home = await mkdtemp(path.join(tmpdir(), 'vpa-rec-routes-'));
  const projects = await mkdtemp(path.join(tmpdir(), 'vpa-rec-projects-'));
  const store = new ProjectStore({ vpaHome: home, projectsDefault: projects });
  const llm = createFakeLlm();
  const probe = createFakeProbe();
  const recoverAttachment = vi.fn(async (projectId: string, sceneId: string, sessionId: string, input: { capturedAt: string; uploadedPath: string }) => {
    const project = await store.readProject(projectId);
    return ingestRecording(project.path, sceneId, input.uploadedPath, await probe(input.uploadedPath), {
      source_kind: 'cap-agent', capture_session_id: sessionId, captured_at: input.capturedAt,
    });
  });

  const app = Fastify();
  await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024, files: 10 } });
  await app.register(async (i) =>
    registerRecordingRoutes(i, { store, llm, workspaceRoot: workspaceRoot(), probe, agentRecordingCoordinator: { recoverAttachment } }),
  );
  return { app, store, llm, home, projects, recoverAttachment };
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
      { id: 'scene-01', name: 'Intro', description: 'Intro scene', type: 'desktop' },
      { id: 'scene-02', name: 'Demo', description: 'Demo scene', type: 'terminal' },
    ],
  };
}

describe('recording routes', () => {
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

  describe('POST /api/projects/:id/scenes/:sceneId/recording', () => {
    it('uploads a recording for a scene', async () => {
      const sb = makeSampleStoryboard(projectId, 'test-proj');
      await saveStoryboard(projectPath, sb);

      const form = new FormData();
      form.append('file', Buffer.from('fake-mp4-data'), {
        filename: 'scene-01.mp4',
        contentType: 'video/mp4',
      });

      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/scenes/scene-01/recording`,
        payload: form.getBuffer(),
        headers: form.getHeaders(),
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.sceneId).toBe('scene-01');
      expect(body.relativePath).toBe('recordings/scene-01.mp4');
      expect(body.metadata.duration_sec).toBe(47.2);
    });

    it('rejects a manual upload while the scene has a nonterminal Cap session', async () => {
      const sb = makeSampleStoryboard(projectId, 'test-proj');
      await saveStoryboard(projectPath, sb);
      await createAgentRecordingSession(projectPath, projectId, 'scene-01');

      const form = new FormData();
      form.append('file', Buffer.from('fake-mp4-data'), {
        filename: 'scene-01.mp4',
        contentType: 'video/mp4',
      });
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/scenes/scene-01/recording`,
        payload: form.getBuffer(),
        headers: form.getHeaders(),
      });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'agent_recording_active' });
      expect((await loadStoryboard(projectPath))?.scenes[0]?.recording).toBeUndefined();
    });

    it('returns 404 when no storyboard exists', async () => {
      const form = new FormData();
      form.append('file', Buffer.from('fake'), { filename: 'test.mp4', contentType: 'video/mp4' });

      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/scenes/scene-01/recording`,
        payload: form.getBuffer(),
        headers: form.getHeaders(),
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('not_found');
    });

    it('returns 404 for non-existent scene', async () => {
      const sb = makeSampleStoryboard(projectId, 'test-proj');
      await saveStoryboard(projectPath, sb);

      const form = new FormData();
      form.append('file', Buffer.from('fake'), { filename: 'test.mp4', contentType: 'video/mp4' });

      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/scenes/no-such-scene/recording`,
        payload: form.getBuffer(),
        headers: form.getHeaders(),
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('scene_not_found');
    });

    it('delegates Cap attachment recovery to the coordinator and saves provenance', async () => {
      const sb = makeSampleStoryboard(projectId, 'test-proj');
      await saveStoryboard(projectPath, sb);
      const sessionId = '11111111-1111-4111-8111-111111111111';

      const form = new FormData();
      form.append('source_kind', 'cap-agent');
      form.append('capture_session_id', sessionId);
      form.append('captured_at', '2026-07-31T12:00:00.000Z');
      form.append('file', Buffer.from('fake-mp4-data'), { filename: 'take.mp4', contentType: 'video/mp4' });
      const res = await ctx.app.inject({ method: 'POST', url: `/api/projects/${projectId}/scenes/scene-01/recording`, payload: form.getBuffer(), headers: form.getHeaders() });

      expect(res.statusCode).toBe(200);
      expect(ctx.recoverAttachment).toHaveBeenCalledWith(projectId, 'scene-01', sessionId, expect.objectContaining({ capturedAt: '2026-07-31T12:00:00.000Z' }));
      const saved = await loadStoryboard(projectPath);
      expect(saved?.scenes[0]?.recording).toMatchObject({ source_kind: 'cap-agent', capture_session_id: sessionId, captured_at: '2026-07-31T12:00:00.000Z' });
    });

    it('rejects troubleshooting Cap provenance while the session still awaits confirmation', async () => {
      const sb = makeSampleStoryboard(projectId, 'test-proj');
      await saveStoryboard(projectPath, sb);
      const sessionId = '22222222-2222-4222-8222-222222222222';
      ctx.recoverAttachment.mockRejectedValueOnce(new Error('not coordinator verified'));

      const form = new FormData();
      form.append('source_kind', 'cap-agent');
      form.append('capture_session_id', sessionId);
      form.append('captured_at', '2026-07-31T12:00:00.000Z');
      form.append('file', Buffer.from('fake-mp4-data'), { filename: 'take.mp4', contentType: 'video/mp4' });
      const res = await ctx.app.inject({ method: 'POST', url: `/api/projects/${projectId}/scenes/scene-01/recording`, payload: form.getBuffer(), headers: form.getHeaders() });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('invalid_capture_session');
      expect((await loadStoryboard(projectPath))?.scenes[0]?.recording).toBeUndefined();
    });
  });

  describe('POST /api/projects/:id/recordings/bulk', () => {
    it('uploads multiple recordings assigned to scenes in order', async () => {
      const sb = makeSampleStoryboard(projectId, 'test-proj');
      await saveStoryboard(projectPath, sb);

      const form = new FormData();
      form.append('file1', Buffer.from('mp4-data-1'), { filename: 'rec-01.mp4', contentType: 'video/mp4' });
      form.append('file2', Buffer.from('mp4-data-2'), { filename: 'rec-02.mp4', contentType: 'video/mp4' });

      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/recordings/bulk`,
        payload: form.getBuffer(),
        headers: form.getHeaders(),
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.assignedCount).toBe(2);
      expect(body.results).toHaveLength(2);
      expect(body.results[0].sceneId).toBe('scene-01');
      expect(body.results[1].sceneId).toBe('scene-02');
    });

    it('returns 404 when no storyboard exists', async () => {
      const form = new FormData();
      form.append('file', Buffer.from('fake'), { filename: 'test.mp4', contentType: 'video/mp4' });

      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/recordings/bulk`,
        payload: form.getBuffer(),
        headers: form.getHeaders(),
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('GET /api/projects/:id/scenes/:sceneId/recording/metadata', () => {
    it('returns 404 when scene has no recording', async () => {
      const sb = makeSampleStoryboard(projectId, 'test-proj');
      await saveStoryboard(projectPath, sb);

      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/scenes/scene-01/recording/metadata`,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('no_recording');
    });

    it('returns 404 for non-existent scene', async () => {
      const sb = makeSampleStoryboard(projectId, 'test-proj');
      await saveStoryboard(projectPath, sb);

      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/scenes/no-such/recording/metadata`,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('scene_not_found');
    });
  });

  describe('POST /api/projects/:id/recordings/generate-storyboard', () => {
    it('generates storyboard from uploaded recordings', async () => {
      const form = new FormData();
      form.append('file1', Buffer.from('mp4-data-1'), { filename: 'intro.mp4', contentType: 'video/mp4' });
      form.append('file2', Buffer.from('mp4-data-2'), { filename: 'demo.mp4', contentType: 'video/mp4' });

      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/recordings/generate-storyboard`,
        payload: form.getBuffer(),
        headers: form.getHeaders(),
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.schema_version).toBe(1);
      expect(body.scenes).toHaveLength(2);
      expect(body.scenes[0].name).toBeTruthy();
      expect(body.scenes[0].recording).toBeDefined();
      expect(body.scenes[0].recording.source).toContain('recordings/');
      expect(body.scenes[1].recording).toBeDefined();
    });

    it('returns 400 when no files uploaded', async () => {
      const form = new FormData();

      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/recordings/generate-storyboard`,
        payload: form.getBuffer(),
        headers: form.getHeaders(),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('no_files');
    });
  });
});
