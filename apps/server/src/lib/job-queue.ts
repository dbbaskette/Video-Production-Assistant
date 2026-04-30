import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Job, JobEvent, JobStatus } from '@vpa/shared';

type Listener = (event: JobEvent) => void;

interface SubscribeOptions {
  replay?: boolean;
}

export class JobQueue {
  private jobs = new Map<string, Job>();
  private emitters = new Map<string, EventEmitter>();

  create(type: string): Job {
    const id = randomUUID();
    const now = new Date().toISOString();
    const job: Job = {
      id,
      type,
      status: 'pending',
      created: now,
      updated: now,
      events: [],
    };
    this.jobs.set(id, job);
    this.emitters.set(id, new EventEmitter());
    return job;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  setStatus(id: string, status: JobStatus): void {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Job not found: ${id}`);
    job.status = status;
    job.updated = new Date().toISOString();
  }

  emit(id: string, type: string, data?: unknown): void {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Job not found: ${id}`);
    const event: JobEvent = {
      type,
      timestamp: new Date().toISOString(),
      data,
    };
    job.events.push(event);
    job.updated = event.timestamp;
    this.emitters.get(id)!.emit('event', event);
  }

  subscribe(id: string, listener: Listener, opts: SubscribeOptions = {}): () => void {
    const emitter = this.emitters.get(id);
    if (!emitter) throw new Error(`Job not found: ${id}`);
    if (opts.replay) {
      const job = this.jobs.get(id)!;
      for (const event of job.events) listener(event);
    }
    emitter.on('event', listener);
    return () => emitter.off('event', listener);
  }

  complete(id: string, result?: unknown): void {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Job not found: ${id}`);
    job.status = 'completed';
    job.result = result;
    job.updated = new Date().toISOString();
    this.emit(id, 'done', result);
  }

  fail(id: string, error: string): void {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Job not found: ${id}`);
    job.status = 'failed';
    job.error = error;
    job.updated = new Date().toISOString();
    this.emit(id, 'error', { error });
  }
}

export const jobQueue = new JobQueue();
