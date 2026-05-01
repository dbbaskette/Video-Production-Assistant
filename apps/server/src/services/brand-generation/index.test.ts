import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brandPaths } from '../brand/paths.js';
import { JobQueue } from '../../lib/job-queue.js';
import { runBrandExtractJob, runBrandGenerateJob } from './index.js';
import { createFakeLlm } from '../llm/fake.js';
import * as extractMod from '../document-extract/index.js';

vi.mock('../document-extract/index.js');

let tmp: string;
let paths: ReturnType<typeof brandPaths>;
let queue: JobQueue;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'vpa-pipeline-'));
  await mkdir(join(tmp, '.vpa'), { recursive: true });
  await mkdir(join(tmp, 'prompts'), { recursive: true });
  await writeFile(join(tmp, 'prompts', 'brand-extract-tokens.md'), 'extract sys');
  await writeFile(join(tmp, 'prompts', 'brand-write-rationale.md'), 'rationale sys');
  paths = brandPaths(tmp, join(tmp, '.vpa'));
  queue = new JobQueue();
  vi.resetAllMocks();
});

afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

describe('runBrandExtractJob', () => {
  it('persists sources, extracts text, runs LLM #1, emits tokens-ready', async () => {
    (extractMod.extract as any).mockResolvedValue({ markdown: '# Source\nbrand text', extractor: 'passthrough' });
    const job = queue.create('brand.extract');
    const events: any[] = [];
    queue.subscribe(job.id, (e) => events.push(e));

    await runBrandExtractJob({
      jobId: job.id,
      queue,
      paths,
      registryFile: paths.registryFile,
      workspaceRoot: tmp,
      llm: createFakeLlm(),
      slug: 'acme',
      brandName: 'Acme',
      sources: [{ kind: 'text', text: 'Acme is bold' }],
    });

    const types = events.map((e) => e.type);
    expect(types).toContain('persisted');
    expect(types).toContain('tokens-ready');
    expect(queue.get(job.id)!.status).toBe('awaiting-input');

    const cached = await readFile(paths.extractedTextMd('acme'), 'utf8');
    expect(cached).toContain('brand text');
  });

  it('marks job failed when extraction throws', async () => {
    (extractMod.extract as any).mockRejectedValue(new Error('PDF corrupt'));
    const job = queue.create('brand.extract');
    await runBrandExtractJob({
      jobId: job.id,
      queue,
      paths,
      registryFile: paths.registryFile,
      workspaceRoot: tmp,
      llm: createFakeLlm(),
      slug: 'acme',
      brandName: 'Acme',
      sources: [{ kind: 'file', path: '/tmp/x.pdf' }],
    });
    expect(queue.get(job.id)!.status).toBe('failed');
    expect(queue.get(job.id)!.error).toMatch(/PDF corrupt/);
  });
});

describe('runBrandGenerateJob', () => {
  it('writes design.md with front matter + LLM-generated rationale', async () => {
    (extractMod.extract as any).mockResolvedValue({ markdown: '', extractor: 'passthrough' });
    const job1 = queue.create('brand.extract');
    await runBrandExtractJob({
      jobId: job1.id, queue, paths, registryFile: paths.registryFile, workspaceRoot: tmp,
      llm: createFakeLlm(), slug: 'acme', brandName: 'Acme',
      sources: [{ kind: 'text', text: 'x' }],
    });

    const tokens = (queue.get(job1.id)!.events.find((e) => e.type === 'tokens-ready')!.data as any).frontMatter;
    const job2 = queue.create('brand.generate');
    await runBrandGenerateJob({
      jobId: job2.id, queue, paths, registryFile: paths.registryFile, workspaceRoot: tmp,
      llm: createFakeLlm(),
      slug: 'acme', brandName: 'Acme', frontMatter: tokens,
    });
    expect(queue.get(job2.id)!.status).toBe('completed');
    const written = await readFile(paths.designMd('acme'), 'utf8');
    expect(written).toMatch(/---\nversion: alpha\nname: Acme/);
    expect(written).toMatch(/## Overview/);
  });
});
