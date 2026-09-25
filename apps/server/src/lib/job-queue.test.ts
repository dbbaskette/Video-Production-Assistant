import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { JobCapacityError, JobIdempotencyError, JobPersistenceError, JobQueue } from './job-queue.js';

async function ledgerPath(): Promise<string> {
  return path.join(await mkdtemp(path.join(tmpdir(), 'vpa-jobs-test-')), 'jobs.json');
}

describe('durable JobQueue', () => {
  it('creates pending jobs and preserves status/result compatibility', () => {
    const queue = new JobQueue();
    const job = queue.create('brand.extract');
    expect(job.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(job.status).toBe('pending');
    queue.setStatus(job.id, 'running');
    queue.complete(job.id, { brand_slug: 'tanzu' });
    expect(queue.get(job.id)).toMatchObject({ status: 'completed', result: { brand_slug: 'tanzu' } });
  });

  it('notifies subscribers and replays retained events', () => {
    const queue = new JobQueue();
    const job = queue.create('brand.extract');
    const live: string[] = [];
    queue.subscribe(job.id, (event) => live.push(event.type));
    queue.emit(job.id, 'persisted', { count: 2 });
    expect(live).toEqual(['persisted']);
    const replay: string[] = [];
    queue.subscribe(job.id, (event) => replay.push(event.type), { replay: true });
    expect(replay).toEqual(['persisted']);
  });

  it('persists identity and recovers in-flight work as interrupted', async () => {
    const filePath = await ledgerPath();
    const first = new JobQueue();
    await first.configure({ filePath });
    const job = first.create('render', {
      projectId: 'project-1',
      label: 'Render',
      inputRevision: 4,
      inputFingerprint: 'sha256:abc',
      idempotencyKey: 'render-0001',
    });
    first.setStatus(job.id, 'running');
    first.emit(job.id, 'progress', { completed: 2, total: 5 });
    await first.flush();

    const second = new JobQueue();
    await second.configure({ filePath });
    expect(second.get(job.id)).toMatchObject({
      id: job.id,
      status: 'interrupted',
      meta: { inputRevision: 4, inputFingerprint: 'sha256:abc' },
      failure: { code: 'server_restarted', retryable: true },
    });
  });

  it('returns an existing job for a matching key and conflicts on changed inputs', async () => {
    const queue = new JobQueue();
    await queue.configure({ filePath: await ledgerPath() });
    const meta = { idempotencyKey: 'operation-0001', inputFingerprint: 'one' };
    const first = queue.create('work', meta);
    expect(queue.create('work', meta)).toBe(first);
    expect(() => queue.create('work', { ...meta, inputFingerprint: 'two' })).toThrow(JobIdempotencyError);
  });

  it('bounds persisted event history and oversized event payloads', async () => {
    const filePath = await ledgerPath();
    const queue = new JobQueue();
    await queue.configure({ filePath });
    const job = queue.create('work');
    for (let index = 0; index < 240; index += 1) queue.emit(job.id, 'progress', { index, raw: 'x'.repeat(70_000) });
    await queue.flush();
    expect(job.events).toHaveLength(200);
    expect((job.events[0]?.data as { raw: string }).raw.length).toBe(512);
    expect((await readFile(filePath, 'utf8')).length).toBeLessThan(150_000);
  });

  it('redacts credentials and absolute paths from public events and results', () => {
    const queue = new JobQueue();
    const job = queue.create('work');
    queue.emit(job.id, 'start', { apiKey: 'secret-value', inputPath: '/private/project/video.mp4' });
    queue.complete(job.id, { token: 'private-token', outputPath: '/private/project/render.mp4' });
    expect(JSON.stringify(job)).not.toContain('secret-value');
    expect(JSON.stringify(job)).not.toContain('/private/project');
    expect(JSON.stringify(job)).toContain('[redacted]');
  });

  it('cancels idempotently and invokes a child abort handler once', async () => {
    const queue = new JobQueue();
    await queue.configure({ filePath: await ledgerPath() });
    const job = queue.create('render');
    queue.setStatus(job.id, 'running');
    const abort = vi.fn();
    queue.registerCancellation(job.id, abort);
    expect(await queue.requestCancellation(job.id)).toEqual({ cancelled: true, status: 'cancelling' });
    expect(await queue.requestCancellation(job.id)).toEqual({ cancelled: true, status: 'cancelling' });
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it('persists bounded structured failures', async () => {
    const queue = new JobQueue();
    await queue.configure({ filePath: await ledgerPath() });
    const job = queue.create('work');
    queue.fail(job.id, 'x'.repeat(500), 'provider_failed', false);
    await queue.flush();
    expect(job.failure).toMatchObject({ code: 'provider_failed', retryable: false });
    expect(job.failure?.message.length).toBe(300);
  });

  it('rejects malformed events and bounds active concurrency', async () => {
    const queue = new JobQueue();
    const first = queue.create('work');
    expect(() => queue.emit(first.id, '', {})).toThrow('required');
    for (let index = 1; index < 16; index += 1) queue.create(`work-${index}`);
    expect(() => queue.create('overflow')).toThrow(JobCapacityError);
  });

  it('does not expose an unpersisted job as successfully submitted on disk exhaustion', async () => {
    const queue = new JobQueue();
    await queue.configure({
      filePath: await ledgerPath(),
      persist: async () => { throw new Error('/private/disk full'); },
    });
    await expect(queue.createDurable('render')).rejects.toBeInstanceOf(JobPersistenceError);
    expect(queue.list()).toEqual([]);
  });
});
