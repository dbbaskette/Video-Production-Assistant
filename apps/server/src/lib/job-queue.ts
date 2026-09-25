import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Job as JobSchema, type Job, type JobEvent, type JobMeta, type JobStatus } from '@vpa/shared';
import { atomicWriteFile } from './fs-atomic.js';

type Listener = (event: JobEvent) => void;
type CancelHandler = () => void | Promise<void>;
type RetryHandler = (job: Job) => void | Promise<void>;

interface SubscribeOptions { replay?: boolean }
interface ListFilter { activeOnly?: boolean; projectId?: string }
interface ConfigureOptions {
  filePath: string;
  persist?: typeof atomicWriteFile;
  warn?: (message: string) => void;
}

export class JobIdempotencyError extends Error {
  readonly code = 'idempotency_conflict';
}

export class JobCapacityError extends Error {
  readonly code = 'job_capacity_reached';
}

export class JobPersistenceError extends Error {
  readonly code = 'job_persistence_failed';
}

const TERMINAL = new Set<JobStatus>(['completed', 'failed', 'cancelled', 'interrupted']);
const MAX_EVENTS = 200;
const MAX_VALUE_BYTES = 64 * 1024;
const MAX_ACTIVE_JOBS = 16;
const MAX_ACTIVE_PROJECT_JOBS = 4;

function boundedText(value: string, max = 300): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function scrubPublicValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[truncated-depth]';
  if (typeof value === 'string') {
    if (value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(value)) return '[redacted-path]';
    return value.length > 512 ? `${value.slice(0, 511)}…` : value;
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => scrubPublicValue(item, depth + 1));
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 200)) {
      output[key] = /(?:api.?key|secret|token|authorization|password|credential)/i.test(key)
        ? '[redacted]'
        : scrubPublicValue(item, depth + 1);
    }
    return output;
  }
  return String(value);
}

function boundedValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    const scrubbed = scrubPublicValue(value);
    const json = JSON.stringify(scrubbed);
    if (Buffer.byteLength(json) <= MAX_VALUE_BYTES) return scrubbed;
    return { truncated: true, originalBytes: Buffer.byteLength(json) };
  } catch {
    return { truncated: true, reason: 'not_serializable' };
  }
}

export class JobQueue {
  private jobs = new Map<string, Job>();
  private emitters = new Map<string, EventEmitter>();
  private cancelHandlers = new Map<string, CancelHandler>();
  private retryHandlers = new Map<string, RetryHandler>();
  private filePath?: string;
  private persist: typeof atomicWriteFile = atomicWriteFile;
  private warn: (message: string) => void = () => undefined;
  private persistTail: Promise<void> = Promise.resolve();
  private persistenceError?: Error;

  async configure(options: ConfigureOptions): Promise<void> {
    await this.flush();
    this.filePath = options.filePath;
    this.persist = options.persist ?? atomicWriteFile;
    this.warn = options.warn ?? (() => undefined);
    this.jobs.clear();
    this.emitters.clear();
    this.cancelHandlers.clear();
    this.persistenceError = undefined;
    try {
      const raw = JSON.parse(await readFile(options.filePath, 'utf8')) as { version?: unknown; jobs?: unknown };
      if (raw.version !== 1 || !Array.isArray(raw.jobs)) throw new Error('Unsupported job ledger.');
      for (const value of raw.jobs) {
        const job = JobSchema.parse(value);
        if (!TERMINAL.has(job.status)) {
          const now = new Date().toISOString();
          job.status = 'interrupted';
          job.updated = now;
          job.failure = { code: 'server_restarted', message: 'Job interrupted by a server restart.', retryable: true };
          job.error = job.failure.message;
          job.events = [...job.events, { type: 'interrupted', timestamp: now, data: { code: 'server_restarted' } }].slice(-MAX_EVENTS);
        }
        this.jobs.set(job.id, job);
        this.emitters.set(job.id, new EventEmitter());
      }
      await this.persistNow();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private async persistNow(): Promise<void> {
    if (!this.filePath) return;
    const jobs = Array.from(this.jobs.values()).map((job) => JobSchema.parse(job));
    await this.persist(this.filePath, JSON.stringify({ version: 1, jobs }, null, 2));
  }

  private schedulePersist(): void {
    this.persistTail = this.persistTail
      .then(async () => {
        await this.persistNow();
        this.persistenceError = undefined;
      })
      .catch((error) => {
        this.persistenceError = error instanceof Error ? error : new Error('Job ledger persistence failed.');
        this.warn(`Job ledger persistence failed: ${this.persistenceError.name}`);
      });
  }

  async flush(): Promise<void> {
    await this.persistTail;
    if (this.persistenceError) throw new JobPersistenceError('The job could not be saved. Free disk space and retry.');
  }

  create(type: string, meta?: JobMeta): Job {
    if (meta?.idempotencyKey) {
      const existing = Array.from(this.jobs.values()).find((job) => job.meta?.idempotencyKey === meta.idempotencyKey);
      if (existing) {
        if (existing.type !== type || existing.meta?.inputFingerprint !== meta.inputFingerprint) {
          throw new JobIdempotencyError('This idempotency key was already used for different job inputs.');
        }
        return existing;
      }
    }
    const active = Array.from(this.jobs.values()).filter((job) => !TERMINAL.has(job.status));
    if (active.length >= MAX_ACTIVE_JOBS) {
      throw new JobCapacityError('Too many jobs are already active. Wait for one to finish and retry.');
    }
    if (meta?.projectId && active.filter((job) => job.meta?.projectId === meta.projectId).length >= MAX_ACTIVE_PROJECT_JOBS) {
      throw new JobCapacityError('This project already has too many active jobs. Wait for one to finish and retry.');
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    const job = JobSchema.parse({ id, type, status: 'pending', created: now, updated: now, events: [], ...(meta ? { meta } : {}) });
    this.jobs.set(id, job);
    this.emitters.set(id, new EventEmitter());
    this.schedulePersist();
    return job;
  }

  /** Create and fsync the ledger boundary before any worker side effects start. */
  async createDurable(type: string, meta?: JobMeta): Promise<Job> {
    const prior = meta?.idempotencyKey ? this.findByIdempotencyKey(meta.idempotencyKey) : undefined;
    const job = this.create(type, meta);
    try {
      await this.flush();
    } catch (error) {
      if (!prior) {
        this.jobs.delete(job.id);
        this.emitters.delete(job.id);
      }
      throw error;
    }
    return job;
  }

  get(id: string): Job | undefined { return this.jobs.get(id); }

  findByIdempotencyKey(key: string): Job | undefined {
    return Array.from(this.jobs.values()).find((job) => job.meta?.idempotencyKey === key);
  }

  list(filter: ListFilter = {}): Job[] {
    return Array.from(this.jobs.values()).filter((job) => {
      if (filter.activeOnly && TERMINAL.has(job.status)) return false;
      if (filter.projectId && job.meta?.projectId !== filter.projectId) return false;
      return true;
    });
  }

  setStatus(id: string, status: JobStatus): void {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Job not found: ${id}`);
    job.status = status;
    job.updated = new Date().toISOString();
    this.schedulePersist();
  }

  emit(id: string, type: string, data?: unknown): void {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Job not found: ${id}`);
    if (!type.trim()) throw new Error('Job event type is required.');
    const event: JobEvent = { type: boundedText(type, 80), timestamp: new Date().toISOString(), data: boundedValue(data) };
    job.events.push(event);
    if (job.events.length > MAX_EVENTS) job.events.splice(0, job.events.length - MAX_EVENTS);
    job.updated = event.timestamp;
    this.emitters.get(id)!.emit('event', event);
    this.schedulePersist();
  }

  subscribe(id: string, listener: Listener, opts: SubscribeOptions = {}): () => void {
    const emitter = this.emitters.get(id);
    if (!emitter) throw new Error(`Job not found: ${id}`);
    if (opts.replay) for (const event of this.jobs.get(id)!.events) listener(event);
    emitter.on('event', listener);
    return () => emitter.off('event', listener);
  }

  complete(id: string, result?: unknown, artifacts?: Job['artifacts']): void {
    const job = this.require(id);
    job.status = 'completed';
    job.result = boundedValue(result);
    job.failure = undefined;
    job.error = undefined;
    job.artifacts = artifacts;
    job.updated = new Date().toISOString();
    this.emit(id, 'done', job.result);
  }

  finishCancelled(id: string, result?: unknown): void {
    const job = this.require(id);
    job.status = 'cancelled';
    job.result = boundedValue(result);
    job.updated = new Date().toISOString();
    this.cancelHandlers.delete(id);
    this.emit(id, 'done', job.result);
  }

  fail(id: string, error: string, code = 'job_failed', retryable = true): void {
    const job = this.require(id);
    const message = boundedText(error);
    job.status = 'failed';
    job.error = message;
    job.failure = { code: boundedText(code, 80), message, retryable };
    job.updated = new Date().toISOString();
    this.cancelHandlers.delete(id);
    this.emit(id, 'error', { error: message, code: job.failure.code, retryable });
  }

  registerCancellation(id: string, handler: CancelHandler): () => void {
    this.require(id);
    this.cancelHandlers.set(id, handler);
    return () => this.cancelHandlers.delete(id);
  }

  async requestCancellation(id: string): Promise<{ cancelled: boolean; status: JobStatus }> {
    const job = this.require(id);
    if (TERMINAL.has(job.status)) return { cancelled: false, status: job.status };
    if (job.status !== 'cancelling') {
      this.setStatus(id, 'cancelling');
      this.emit(id, 'cancel-requested', {});
      await this.cancelHandlers.get(id)?.();
    }
    return { cancelled: true, status: 'cancelling' };
  }

  registerRetryHandler(type: string, handler: RetryHandler): () => void {
    this.retryHandlers.set(type, handler);
    return () => this.retryHandlers.delete(type);
  }

  async retry(id: string): Promise<Job> {
    const job = this.require(id);
    if (job.status !== 'failed' && job.status !== 'interrupted') return job;
    const handler = this.retryHandlers.get(job.type);
    if (!handler) throw new Error('This job type does not have a restart handler.');
    job.status = 'pending';
    job.failure = undefined;
    job.error = undefined;
    job.updated = new Date().toISOString();
    this.emit(id, 'retry', {});
    await handler(job);
    return job;
  }

  private require(id: string): Job {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Job not found: ${id}`);
    return job;
  }
}

export const jobQueue = new JobQueue();
