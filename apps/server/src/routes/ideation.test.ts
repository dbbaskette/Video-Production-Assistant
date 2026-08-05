import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { ProjectStore } from '../services/project/store.js';
import { IdeationManager } from '../services/ideation/index.js';
import { createFakeLlm, type LlmClient } from '../services/llm/index.js';
import { ModelRoutingError, type ModelRouter } from '../services/llm/model-router.js';
import { registerIdeationRoutes } from './ideation.js';
import { addText } from '../services/project-source-docs/index.js';
import { REFERENCE_BUDGET_CHARS } from '../services/project-source-docs/context.js';

async function buildTestServer(opts: { writer?: LlmClient; general?: LlmClient } = {}) {
  const home = await mkdtemp(path.join(tmpdir(), 'vpa-id-routes-'));
  const projects = await mkdtemp(path.join(tmpdir(), 'vpa-id-projects-'));
  const store = new ProjectStore({ vpaHome: home, projectsDefault: projects });
  const writer = opts.writer ?? createFakeLlm();
  const general = opts.general ?? createFakeLlm();
  const generalComplete = vi.spyOn(general, 'complete');
  const resolveText = vi.fn(async (role: 'writing' | 'general') => ({
    client: role === 'writing' ? writer : general,
    summary: {
      role,
      scope: 'project' as const,
      entry_id: `${role}-model`,
      provider: 'fake' as const,
      model: `fake-${role}`,
      name: role,
      capabilities: { text: true, video: false },
      ready: true as const,
    },
  }));
  const router = { resolveText } as unknown as ModelRouter;
  const ideationManager = new IdeationManager();
  const app = Fastify();
  await app.register(async (i) => registerIdeationRoutes(i, { store, router, ideationManager }));
  return { app, store, writer, general, generalComplete, resolveText, ideationManager, home, projects };
}

describe('ideation routes', () => {
  let ctx: Awaited<ReturnType<typeof buildTestServer>>;
  let projectId: string;

  beforeEach(async () => {
    ctx = await buildTestServer();
    const project = await ctx.store.create({ name: 'test-proj', objective: 'test demo' });
    projectId = project.id;
  });

  afterEach(async () => {
    await ctx.app.close();
    await rm(ctx.home, { recursive: true, force: true });
    await rm(ctx.projects, { recursive: true, force: true });
  });

  it('GET ideation returns empty session for new project', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/ideation`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.projectId).toBe(projectId);
    expect(body.messages).toEqual([]);
    expect(body.proposedScenes).toEqual([]);
  });

  it('POST message returns assistant response with scenes', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/ideation/message`,
      payload: { content: 'I want to demo setting up an MCP server' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.role).toBe('assistant');
    expect(body.content).toBeTruthy();
    expect(body.scenes).toBeDefined();
    expect(body.scenes.length).toBeGreaterThan(0);
    expect(body.scenes[0].name).toBeTruthy();
    expect(ctx.resolveText).toHaveBeenCalledWith(
      'writing',
      expect.objectContaining({ id: projectId }),
    );
    expect(ctx.resolveText).not.toHaveBeenCalledWith('general', expect.anything());
  });

  it('returns a stable routing error without creating conversation state', async () => {
    ctx.resolveText.mockRejectedValueOnce(new ModelRoutingError(
      'model_unavailable',
      'writing',
      'project',
      'The assigned model for writing is unavailable.',
      503,
    ));

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/ideation/message`,
      payload: { content: 'Do not lose this' },
    });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'model_unavailable', role: 'writing' });
    expect(ctx.ideationManager.get(projectId)).toBeUndefined();
  });

  it('resolves general separately when source documents need summarization', async () => {
    const project = await ctx.store.readProject(projectId);
    await addText(project.path, 'f'.repeat(REFERENCE_BUDGET_CHARS + 1), 'large-reference.md');

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/ideation/message`,
      payload: { content: 'Ground this in the source' },
    });

    expect(res.statusCode).toBe(200);
    expect(ctx.resolveText.mock.calls.map(([role]) => role)).toEqual(['writing', 'general']);
    expect(ctx.generalComplete).toHaveBeenCalledOnce();
  });

  it('bounds provider failures and leaves the conversation unchanged', async () => {
    const failingWriter: LlmClient = {
      async complete() {
        throw new Error('secret upstream diagnostic');
      },
    };
    await ctx.app.close();
    await rm(ctx.home, { recursive: true, force: true });
    await rm(ctx.projects, { recursive: true, force: true });
    ctx = await buildTestServer({ writer: failingWriter });
    const project = await ctx.store.create({ name: 'provider-failure' });

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/ideation/message`,
      payload: { content: 'Keep this transactional' },
    });

    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({
      error: 'Ideation failed. Your existing ideas were not changed.',
      code: 'ideation_failed',
    });
    expect(JSON.stringify(res.json())).not.toContain('secret upstream diagnostic');
    expect(ctx.ideationManager.get(project.id)?.getState().messages).toEqual([]);
  });

  it('GET ideation after sending a message shows history', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/ideation/message`,
      payload: { content: 'Demo MCP setup' },
    });

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/ideation`,
    });
    const body = res.json();
    expect(body.messages).toHaveLength(2); // user + assistant
    expect(body.messages[0].role).toBe('user');
    expect(body.messages[1].role).toBe('assistant');
    expect(body.proposedScenes.length).toBeGreaterThan(0);
  });

  it('POST accept writes storyboard.yaml and returns it', async () => {
    // First send a message to get scene proposals
    await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/ideation/message`,
      payload: { content: 'Demo MCP setup' },
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/ideation/accept`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.schema_version).toBe(1);
    expect(body.scenes.length).toBeGreaterThan(0);
    expect(body.project.name).toBe('test-proj');

    // Verify storyboard.yaml was written to disk
    const tracker = await ctx.store.readTracker();
    const entry = tracker.projects.find((p) => p.id === projectId)!;
    const sbPath = path.join(entry.path, 'storyboard.yaml');
    const content = await readFile(sbPath, 'utf8');
    expect(content).toContain('schema_version: 1');
  });

  it('POST accept with no session returns 400', async () => {
    // Create a second project that has never had GET /ideation called
    const proj2 = await ctx.store.create({ name: 'no-session-proj' });
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${proj2.id}/ideation/accept`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('no_session');
  });

  it('POST message with empty content returns 400', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/ideation/message`,
      payload: { content: '' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('invalid_request');
  });

  it('POST message with missing content returns 400', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/ideation/message`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});
