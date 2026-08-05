import { readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  PresentationJobSchema,
  type PresentationJob,
} from '@vpa/shared';
import { atomicWriteFile } from '../../lib/fs-atomic.js';
import { projectFiles } from '../project/paths.js';

export type PresentationJobStoreErrorCode =
  | 'invalid_job_id'
  | 'invalid_job'
  | 'job_not_found';

export class PresentationJobStoreError extends Error {
  constructor(readonly code: PresentationJobStoreErrorCode, message: string) {
    super(message);
    this.name = 'PresentationJobStoreError';
  }
}

const JobIdSchema = z.string().uuid();

function validatedId(id: string): string {
  if (!JobIdSchema.safeParse(id).success) {
    throw new PresentationJobStoreError('invalid_job_id', 'Invalid presentation job id');
  }
  return id;
}

function parseJob(value: unknown, expectedId?: string): PresentationJob {
  const parsed = PresentationJobSchema.safeParse(value);
  if (!parsed.success || (expectedId !== undefined && parsed.data.id !== expectedId)) {
    throw new PresentationJobStoreError('invalid_job', 'Invalid presentation job record');
  }
  return parsed.data;
}

export class PresentationJobStore {
  private readonly persist: typeof atomicWriteFile;

  constructor(private readonly options: {
    warn: (fields: Record<string, unknown>, message: string) => void;
    persist?: typeof atomicWriteFile;
  }) {
    this.persist = options.persist ?? atomicWriteFile;
  }

  private jobPath(projectPath: string, id: string): string {
    return path.join(projectFiles(projectPath).presentationJobsDir, `${validatedId(id)}.json`);
  }

  private async write(projectPath: string, job: PresentationJob): Promise<PresentationJob> {
    const validated = parseJob(job);
    await this.persist(this.jobPath(projectPath, validated.id), JSON.stringify(validated, null, 2));
    return validated;
  }

  private warnInvalidRecord(jobId: string): void {
    try {
      this.options.warn(
        { errorName: 'InvalidPresentationJobRecord', jobId },
        'Ignored invalid presentation job record',
      );
    } catch {
      // Diagnostics must not alter job-store behavior.
    }
  }

  async create(projectPath: string, job: PresentationJob): Promise<PresentationJob> {
    return this.write(projectPath, parseJob(job));
  }

  async read(projectPath: string, id: string): Promise<PresentationJob | null> {
    const target = this.jobPath(projectPath, id);
    let text: string;
    try {
      text = await readFile(target, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    try {
      return parseJob(JSON.parse(text), id);
    } catch (error) {
      if (error instanceof PresentationJobStoreError) throw error;
      throw new PresentationJobStoreError('invalid_job', 'Invalid presentation job record');
    }
  }

  async update(
    projectPath: string,
    id: string,
    patch: Partial<PresentationJob>,
  ): Promise<PresentationJob> {
    const current = await this.read(projectPath, id);
    if (!current) {
      throw new PresentationJobStoreError('job_not_found', 'Presentation job not found');
    }
    const updated = parseJob({
      ...current,
      ...patch,
      id: current.id,
      project_id: current.project_id,
      updated_at: new Date().toISOString(),
    });
    return this.write(projectPath, updated);
  }

  async list(projectPath: string): Promise<PresentationJob[]> {
    const directory = projectFiles(projectPath).presentationJobsDir;
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }

    const jobs: PresentationJob[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const id = entry.slice(0, -'.json'.length);
      if (!JobIdSchema.safeParse(id).success) continue;
      try {
        const job = await this.read(projectPath, id);
        if (job) jobs.push(job);
      } catch (error) {
        if (!(error instanceof PresentationJobStoreError)) throw error;
        this.warnInvalidRecord(id);
      }
    }
    return jobs.sort((left, right) => right.created_at.localeCompare(left.created_at));
  }

  async delete(projectPath: string, id: string): Promise<void> {
    await rm(this.jobPath(projectPath, id), { force: true });
  }
}
