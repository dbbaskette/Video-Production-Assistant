import { describe, it, expect, beforeEach } from 'vitest';
import { JobQueue } from './job-queue.js';

describe('JobQueue', () => {
  let queue: JobQueue;
  beforeEach(() => { queue = new JobQueue(); });

  it('creates a job with pending status', () => {
    const job = queue.create('brand.extract');
    expect(job.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(job.status).toBe('pending');
    expect(job.type).toBe('brand.extract');
    expect(job.events).toEqual([]);
  });

  it('emits events to subscribers and stores them on the job', () => {
    const job = queue.create('brand.extract');
    const received: any[] = [];
    queue.subscribe(job.id, (evt) => received.push(evt));
    queue.emit(job.id, 'persisted', { count: 2 });
    expect(received).toHaveLength(1);
    expect(received[0].type).toBe('persisted');
    expect(received[0].data).toEqual({ count: 2 });
    expect(queue.get(job.id)!.events).toHaveLength(1);
  });

  it('transitions through statuses', () => {
    const job = queue.create('brand.extract');
    queue.setStatus(job.id, 'running');
    expect(queue.get(job.id)!.status).toBe('running');
    queue.complete(job.id, { brand_slug: 'tanzu' });
    expect(queue.get(job.id)!.status).toBe('completed');
    expect(queue.get(job.id)!.result).toEqual({ brand_slug: 'tanzu' });
  });

  it('records error on fail', () => {
    const job = queue.create('brand.extract');
    queue.fail(job.id, 'LLM rejected JSON');
    expect(queue.get(job.id)!.status).toBe('failed');
    expect(queue.get(job.id)!.error).toBe('LLM rejected JSON');
  });

  it('replays past events to a late subscriber', () => {
    const job = queue.create('brand.extract');
    queue.emit(job.id, 'a');
    queue.emit(job.id, 'b');
    const received: any[] = [];
    queue.subscribe(job.id, (evt) => received.push(evt), { replay: true });
    expect(received.map(e => e.type)).toEqual(['a', 'b']);
  });
});
