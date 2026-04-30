import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { healthRoutes } from './health.js';
import { projectsRoutes } from './projects.js';
import { ProjectStore } from '../services/project/store.js';

async function buildTestServer() {
  const home = await mkdtemp(path.join(tmpdir(), 'vpa-routes-home-'));
  const projects = await mkdtemp(path.join(tmpdir(), 'vpa-routes-projects-'));
  const config = {
    port: 0,
    host: '127.0.0.1',
    vpaHome: home,
    projectsDefault: projects,
    webOrigin: 'http://localhost:5173',
  };
  const store = new ProjectStore({ vpaHome: home, projectsDefault: projects });
  const app = Fastify();
  await app.register(cors, { origin: [config.webOrigin] });
  await app.register(healthRoutes);
  await app.register(async (i) => projectsRoutes(i, { store, config }));
  return { app, home, projects };
}

describe('projects routes', () => {
  let ctx: Awaited<ReturnType<typeof buildTestServer>>;
  beforeEach(async () => {
    ctx = await buildTestServer();
  });
  afterEach(async () => {
    await ctx.app.close();
    await rm(ctx.home, { recursive: true, force: true });
    await rm(ctx.projects, { recursive: true, force: true });
  });

  it('GET /api/projects returns empty list initially', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/projects' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ projects: [] });
  });

  it('POST /api/projects creates a project', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'demo-1', objective: 'show X' },
    });
    expect(res.statusCode).toBe(200);
    const project = res.json();
    expect(project.name).toBe('demo-1');
    expect(project.path).toBe(path.join(ctx.projects, 'demo-1'));
  });

  it('POST /api/projects rejects duplicate name with 409', async () => {
    await ctx.app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'dup' } });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'dup' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('POST /api/projects rejects invalid name with 400', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'bad name with spaces' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /api/projects/import returns 404 when project.yaml is missing', async () => {
    const empty = await mkdtemp(path.join(tmpdir(), 'vpa-empty-import-'));
    try {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/projects/import',
        payload: { path: empty },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it('GET /api/config/defaults returns the configured projects root', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/config/defaults' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ projectsDefault: ctx.projects });
  });
});
