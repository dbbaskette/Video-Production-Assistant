import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerBrandRoutes } from './brands.js';
import { registerJobRoutes } from './jobs.js';
import { jobQueue } from '../lib/job-queue.js';
import { brandPaths } from '../services/brand/paths.js';

let app: FastifyInstance;
let tmp: string;

async function waitForStatus(
  jobId: string,
  target: string,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const j = jobQueue.get(jobId);
    if (j?.status === target) return;
    if (j?.status === 'failed') throw new Error(`Job failed: ${j.error}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timeout waiting for status ${target}`);
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'vpa-brand-routes-'));
  const vpaDir = join(tmp, '.vpa');
  await mkdir(vpaDir, { recursive: true });
  await mkdir(join(tmp, 'prompts'), { recursive: true });
  await writeFile(join(tmp, 'prompts', 'brand-extract-tokens.md'), 'sys');
  await writeFile(join(tmp, 'prompts', 'brand-write-rationale.md'), 'sys');

  app = Fastify();
  await app.register(multipart, { limits: { fileSize: 50_000_000, files: 10 } });
  const paths = brandPaths(tmp, vpaDir);
  await registerBrandRoutes(app, {
    paths,
    registryFile: paths.registryFile,
    workspaceRoot: tmp,
  });
  await registerJobRoutes(app);
});

afterEach(async () => {
  await app.close();
  await rm(tmp, { recursive: true, force: true });
});

describe('GET /api/brands', () => {
  it('returns empty brand list initially', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/brands' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('brands');
    expect(body.brands).toEqual([]);
  });
});

describe('POST /api/brands', () => {
  it('creates brand from free_text and returns 202 with slug + job_id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/brands',
      payload: { name: 'Acme Corp', free_text: 'Brand guidelines for Acme Corp' },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body).toHaveProperty('slug', 'acme-corp');
    expect(body).toHaveProperty('job_id');
    expect(typeof body.job_id).toBe('string');
  });

  it('rejects missing name with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/brands',
      payload: { free_text: 'some text' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toMatch(/name/i);
  });

  it('rejects no source with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/brands',
      payload: { name: 'Empty Brand' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toMatch(/source/i);
  });

  it('rejects duplicate slug with 409', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/brands',
      payload: { name: 'Dupe Brand', free_text: 'some text' },
    });
    // Wait for first job to reach awaiting-input before creating another
    await new Promise((r) => setTimeout(r, 200));

    const res = await app.inject({
      method: 'POST',
      url: '/api/brands',
      payload: { name: 'Dupe Brand', free_text: 'other text' },
    });
    expect(res.statusCode).toBe(409);
  });
});

describe('POST /api/brands/:slug/generate', () => {
  it('resumes with front_matter and completes the brand', async () => {
    // Step 1: Create brand
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/brands',
      payload: { name: 'Gen Brand', free_text: 'Brand info for Gen Brand' },
    });
    expect(createRes.statusCode).toBe(202);
    const { slug, job_id: extractJobId } = createRes.json();

    // Step 2: Wait for extract to reach awaiting-input
    await waitForStatus(extractJobId, 'awaiting-input');

    // Step 3: Get extracted tokens from the job
    const extractJob = jobQueue.get(extractJobId)!;
    const tokensEvent = extractJob.events.find((e) => e.type === 'tokens-ready');
    expect(tokensEvent).toBeDefined();
    const frontMatter = (tokensEvent!.data as any).frontMatter;

    // Step 4: Resume with generate
    const genRes = await app.inject({
      method: 'POST',
      url: `/api/brands/${slug}/generate`,
      payload: { front_matter: frontMatter },
    });
    expect(genRes.statusCode).toBe(202);
    const { job_id: genJobId } = genRes.json();

    // Step 5: Wait for generation to complete
    await waitForStatus(genJobId, 'completed');

    // Step 6: Verify brand exists via detail endpoint
    const detailRes = await app.inject({
      method: 'GET',
      url: `/api/brands/${slug}`,
    });
    expect(detailRes.statusCode).toBe(200);
    const detail = detailRes.json();
    expect(detail.registry.name).toBe('Gen Brand');
    expect(detail.doc.frontMatter).toBeDefined();
    expect(detail.doc.body).toBeTruthy();
  });
});

describe('GET /api/brands/:slug', () => {
  it('returns 404 for unknown slug', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/brands/no-such-brand',
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /api/brands/:slug/download', () => {
  it('streams design.md after brand is fully generated', async () => {
    // Create and generate a brand first
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/brands',
      payload: { name: 'Download Test', free_text: 'Text for download test' },
    });
    const { slug, job_id: extractJobId } = createRes.json();
    await waitForStatus(extractJobId, 'awaiting-input');

    const extractJob = jobQueue.get(extractJobId)!;
    const tokensEvent = extractJob.events.find((e) => e.type === 'tokens-ready');
    const frontMatter = (tokensEvent!.data as any).frontMatter;

    const genRes = await app.inject({
      method: 'POST',
      url: `/api/brands/${slug}/generate`,
      payload: { front_matter: frontMatter },
    });
    const { job_id: genJobId } = genRes.json();
    await waitForStatus(genJobId, 'completed');

    // Now test download
    const res = await app.inject({
      method: 'GET',
      url: `/api/brands/${slug}/download`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/markdown; charset=utf-8');
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="${slug}-design.md"`,
    );
    expect(res.body).toContain('---');
  });

  it('returns 404 for missing brand download', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/brands/no-such-brand/download',
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('DELETE /api/brands/:slug', () => {
  it('removes the brand and returns 204', async () => {
    // Create and generate a brand first
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/brands',
      payload: { name: 'Delete Me', free_text: 'Text for delete test' },
    });
    const { slug, job_id: extractJobId } = createRes.json();
    await waitForStatus(extractJobId, 'awaiting-input');

    const extractJob = jobQueue.get(extractJobId)!;
    const tokensEvent = extractJob.events.find((e) => e.type === 'tokens-ready');
    const frontMatter = (tokensEvent!.data as any).frontMatter;

    const genRes = await app.inject({
      method: 'POST',
      url: `/api/brands/${slug}/generate`,
      payload: { front_matter: frontMatter },
    });
    const { job_id: genJobId } = genRes.json();
    await waitForStatus(genJobId, 'completed');

    // Delete
    const delRes = await app.inject({
      method: 'DELETE',
      url: `/api/brands/${slug}`,
    });
    expect(delRes.statusCode).toBe(204);

    // Verify gone
    const detailRes = await app.inject({
      method: 'GET',
      url: `/api/brands/${slug}`,
    });
    expect(detailRes.statusCode).toBe(404);
  });

  it('returns 404 for unknown slug', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/brands/no-such-brand',
    });
    expect(res.statusCode).toBe(404);
  });
});
