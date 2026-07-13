import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import FormData from 'form-data';
import { ProjectStore } from '../services/project/store.js';
import { registerSourceDocsRoutes } from './source-docs.js';

async function buildTestServer() {
  const home = await mkdtemp(path.join(tmpdir(), 'vpa-srcdoc-home-'));
  const projects = await mkdtemp(path.join(tmpdir(), 'vpa-srcdoc-projects-'));
  const store = new ProjectStore({ vpaHome: home, projectsDefault: projects });
  const app = Fastify();
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 10 } });
  await app.register(async (i) => registerSourceDocsRoutes(i, { store }));
  return { app, store, home, projects };
}

describe('source-docs routes', () => {
  let ctx: Awaited<ReturnType<typeof buildTestServer>>;
  let projectId: string;

  beforeEach(async () => {
    ctx = await buildTestServer();
    const project = await ctx.store.create({ name: 'test-proj' });
    projectId = project.id;
  });

  afterEach(async () => {
    await ctx.app.close();
    await rm(ctx.home, { recursive: true, force: true });
    await rm(ctx.projects, { recursive: true, force: true });
  });

  it('uploading a passthrough .txt returns it "ready" immediately', async () => {
    const form = new FormData();
    form.append('file0', Buffer.from('reference material here'), {
      filename: 'notes.txt',
      contentType: 'text/plain',
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/source-docs`,
      payload: form.getBuffer(),
      headers: form.getHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const { created } = res.json();
    expect(created).toHaveLength(1);
    expect(created[0].status).toBe('ready');
    expect(created[0].extractedChars).toBeGreaterThan(0);
  });

  it('registering a URL returns "extracting" without blocking on the fetch', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/source-docs`,
      payload: { url: 'https://example.com/pricing', name: 'Pricing' },
    });

    expect(res.statusCode).toBe(200);
    const { created } = res.json();
    expect(created).toHaveLength(1);
    expect(created[0].kind).toBe('url');
    // The request must NOT wait for the network fetch/extraction — it returns
    // an 'extracting' stub that the background pass will finish.
    expect(created[0].status).toBe('extracting');
  });

  it('a text note is stored ready and shows up in the list', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/source-docs`,
      payload: { text: 'pasted note body', name: 'My Note' },
    });

    const list = await ctx.app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/source-docs`,
    });
    expect(list.statusCode).toBe(200);
    const docs = list.json();
    expect(docs).toHaveLength(1);
    expect(docs[0].name).toBe('My Note');
    expect(docs[0].status).toBe('ready');
  });
});
