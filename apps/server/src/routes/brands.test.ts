import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerBrandRoutes } from './brands.js';
import { registerJobRoutes } from './jobs.js';
import { jobQueue } from '../lib/job-queue.js';
import { brandPaths, BrandPaths } from '../services/brand/paths.js';
import { dumpYaml } from '../lib/yaml.js';
import { v4 as uuidv4 } from 'uuid';

let app: FastifyInstance;
let tmp: string;
let vpaDir: string;
let paths: BrandPaths;

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

/** Helper: create a brand via POST, wait for extract, then generate to completion. */
async function createAndGenerate(
  testApp: FastifyInstance,
  name: string,
  freeText: string,
): Promise<{ slug: string }> {
  const create = await testApp.inject({
    method: 'POST',
    url: '/api/brands',
    payload: { name, free_text: freeText },
  });
  const { job_id, slug } = create.json();
  await waitForStatus(job_id, 'awaiting-input');
  const tokens = (jobQueue.get(job_id)!.events.find((e) => e.type === 'tokens-ready')!.data as any).frontMatter;
  const gen = await testApp.inject({
    method: 'POST',
    url: `/api/brands/${slug}/generate`,
    payload: { front_matter: tokens },
  });
  await waitForStatus(gen.json().job_id, 'completed');
  return { slug };
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'vpa-brand-routes-'));
  vpaDir = join(tmp, '.vpa');
  await mkdir(vpaDir, { recursive: true });
  await mkdir(join(tmp, 'prompts'), { recursive: true });
  await writeFile(join(tmp, 'prompts', 'brand-extract-tokens.md'), 'sys');
  await writeFile(join(tmp, 'prompts', 'brand-write-rationale.md'), 'sys');

  app = Fastify();
  await app.register(multipart, { limits: { fileSize: 50_000_000, files: 10 } });
  paths = brandPaths(tmp, vpaDir);
  const { createFakeLlm } = await import('../services/llm/fake.js');
  await registerBrandRoutes(app, {
    paths,
    registryFile: paths.registryFile,
    workspaceRoot: tmp,
    trackerPath: join(vpaDir, 'projects.json'),
    llm: createFakeLlm(),
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

  it('returns 409 when projects reference the brand (project guard)', async () => {
    const { slug } = await createAndGenerate(app, 'Guarded Brand', 'text for guard');

    // Create a fake project that references this brand
    const projDir = join(tmp, 'projects', 'my-proj');
    await mkdir(projDir, { recursive: true });
    const projId = uuidv4();
    await writeFile(
      join(projDir, 'project.yaml'),
      dumpYaml({
        id: projId,
        name: 'my-proj',
        path: projDir,
        created: new Date().toISOString(),
        brand: { id: slug, applied_version: 1 },
      }),
    );
    // Write the tracker so the delete guard can find it
    await writeFile(
      join(vpaDir, 'projects.json'),
      JSON.stringify({
        version: 1,
        projects: [{ id: projId, name: 'my-proj', path: projDir, lastOpened: null }],
      }),
    );

    // Attempt delete without force — should be 409
    const delRes = await app.inject({
      method: 'DELETE',
      url: `/api/brands/${slug}`,
    });
    expect(delRes.statusCode).toBe(409);
    const body = delRes.json();
    expect(body).toHaveProperty('referencing_projects');
    expect(body.referencing_projects).toHaveLength(1);

    // Delete with force=true — should succeed
    const forceRes = await app.inject({
      method: 'DELETE',
      url: `/api/brands/${slug}?force=true`,
    });
    expect(forceRes.statusCode).toBe(204);
  });
});

describe('POST /api/brands/:slug/fork', () => {
  it('forks an existing brand and returns 201', async () => {
    const { slug: parentSlug } = await createAndGenerate(app, 'ForkParent', 'text for fork parent');

    const res = await app.inject({
      method: 'POST',
      url: `/api/brands/${parentSlug}/fork`,
      payload: { name: 'ForkParent · Q4 Launch' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.registry).toBeDefined();
    expect(body.registry.name).toBe('ForkParent · Q4 Launch');
    expect(body.registry.forked_from).toBe(parentSlug);
    expect(body.registry.id).toContain('--');
    expect(body.doc).toBeDefined();
  });

  it('returns 404 if parent slug does not exist', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/brands/no-such-parent/fork',
      payload: { name: 'Child' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 400 if name is missing', async () => {
    const { slug } = await createAndGenerate(app, 'ForkParent2', 'text for fork parent 2');
    const res = await app.inject({
      method: 'POST',
      url: `/api/brands/${slug}/fork`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('PUT /api/brands/:slug', () => {
  it('sets and unsets default brand', async () => {
    const { slug } = await createAndGenerate(app, 'Default Brand', 'text for default');

    // Set as default
    const setRes = await app.inject({
      method: 'PUT',
      url: `/api/brands/${slug}`,
      payload: { is_default: true },
    });
    expect(setRes.statusCode).toBe(200);
    const setBody = setRes.json();
    expect(setBody.registry.id).toBe(slug);

    // List to verify default
    const listRes = await app.inject({ method: 'GET', url: '/api/brands' });
    expect(listRes.json().default_brand_id).toBe(slug);

    // Unset default
    const unsetRes = await app.inject({
      method: 'PUT',
      url: `/api/brands/${slug}`,
      payload: { is_default: false },
    });
    expect(unsetRes.statusCode).toBe(200);

    const listRes2 = await app.inject({ method: 'GET', url: '/api/brands' });
    expect(listRes2.json().default_brand_id).toBeNull();
  });

  it('returns 404 for unknown slug', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/brands/no-such-brand',
      payload: { is_default: true },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /api/brands/:slug/regenerate', () => {
  it('regenerates tokens with version bump and returns 202', async () => {
    const { slug } = await createAndGenerate(app, 'RegenBrand', 'text for regen');

    // Verify initial version
    const detailRes = await app.inject({
      method: 'GET',
      url: `/api/brands/${slug}`,
    });
    expect(detailRes.json().registry.version).toBe(1);

    // Regenerate
    const regenRes = await app.inject({
      method: 'POST',
      url: `/api/brands/${slug}/regenerate`,
    });
    expect(regenRes.statusCode).toBe(202);
    const { job_id } = regenRes.json();
    expect(job_id).toBeDefined();

    await waitForStatus(job_id, 'completed');

    // Verify version bumped
    const detail2 = await app.inject({
      method: 'GET',
      url: `/api/brands/${slug}`,
    });
    expect(detail2.json().registry.version).toBe(2);
  });

  it('returns 404 for unknown slug', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/brands/no-such-brand/regenerate',
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 409 if no cached extraction exists', async () => {
    // Create brand via the generate pipeline but remove cached text
    const { slug } = await createAndGenerate(app, 'NoCacheBrand', 'text for no-cache');

    // Remove the cached extracted-text.md
    const { rm: rmFile } = await import('node:fs/promises');
    await rmFile(paths.extractedTextMd(slug));

    const res = await app.inject({
      method: 'POST',
      url: `/api/brands/${slug}/regenerate`,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/cached/i);
  });
});
