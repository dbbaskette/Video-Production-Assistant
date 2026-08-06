import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { PresentationJob } from '@vpa/shared';
import { PresentationJobStore } from './job-store.js';

const PROJECT_ID = '11111111-1111-1111-1111-111111111111';
const JOB_ONE = '22222222-2222-4222-8222-222222222222';
const JOB_TWO = '33333333-3333-4333-8333-333333333333';

function job(id = JOB_ONE, createdAt = '2026-08-05T12:00:00.000Z'): PresentationJob {
  return {
    schema_version: 1,
    id,
    project_id: PROJECT_ID,
    filename: 'Quarterly review.pdf',
    status: 'processing',
    stage: 'processing-slides',
    generate_narration: false,
    page_count: 3,
    processed_pages: 1,
    analyzed_pages: 0,
    scripted_pages: 0,
    remaining_scene_count: 0,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

describe('PresentationJobStore', () => {
  let projectPath: string;
  let warn: ReturnType<typeof vi.fn>;
  let store: PresentationJobStore;

  beforeEach(async () => {
    projectPath = await mkdtemp(path.join(tmpdir(), 'vpa-presentation-jobs-'));
    warn = vi.fn();
    store = new PresentationJobStore({ warn });
  });

  afterEach(async () => {
    await rm(projectPath, { recursive: true, force: true });
  });

  it('creates, reads, updates, and lists validated jobs newest first', async () => {
    await store.create(projectPath, job());
    await store.create(projectPath, job(JOB_TWO, '2026-08-05T13:00:00.000Z'));

    expect(await store.read(projectPath, JOB_ONE)).toEqual(job());
    const updated = await store.update(projectPath, JOB_ONE, {
      id: JOB_TWO,
      project_id: '44444444-4444-4444-8444-444444444444',
      status: 'ready',
      stage: 'ready',
      processed_pages: 3,
      remaining_scene_count: 3,
    });
    expect(updated).toMatchObject({
      id: JOB_ONE,
      project_id: PROJECT_ID,
      status: 'ready',
      stage: 'ready',
      processed_pages: 3,
      remaining_scene_count: 3,
    });
    expect(updated.updated_at).not.toBe(job().updated_at);
    expect((await store.list(projectPath)).map(({ id }) => id)).toEqual([JOB_TWO, JOB_ONE]);
  });

  it('preserves the previous record when the real atomic write cannot create its temporary file', async () => {
    await store.create(projectPath, job());
    const jobsDir = path.join(projectPath, 'presentation-jobs');
    await chmod(jobsDir, 0o500);
    try {
      await expect(store.update(projectPath, JOB_ONE, { filename: 'Must not persist.pdf' })).rejects.toThrow();
    } finally {
      await chmod(jobsDir, 0o700);
    }

    expect(await store.read(projectPath, JOB_ONE)).toEqual(job());
  });

  it('returns null when a job is missing', async () => {
    await expect(store.read(projectPath, JOB_ONE)).resolves.toBeNull();
  });

  it('rejects invalid IDs before joining filesystem paths', async () => {
    for (const id of ['../storyboard', 'not-a-uuid', `${JOB_ONE}/extra`]) {
      await expect(store.read(projectPath, id)).rejects.toMatchObject({
        code: 'invalid_job_id',
        message: 'Invalid presentation job id',
      });
      await expect(store.delete(projectPath, id)).rejects.toMatchObject({ code: 'invalid_job_id' });
    }
    expect(await readdir(projectPath)).toEqual([]);
  });

  it('rejects invalid create, update, and read data with bounded public errors', async () => {
    await expect(store.create(projectPath, { ...job(), filename: 'x'.repeat(10_000) })).rejects.toMatchObject({
      code: 'invalid_job',
      message: 'Invalid presentation job record',
    });
    await store.create(projectPath, job());
    await expect(store.update(projectPath, JOB_ONE, { page_count: -1 })).rejects.toMatchObject({
      code: 'invalid_job',
      message: 'Invalid presentation job record',
    });
    await writeFile(path.join(projectPath, 'presentation-jobs', `${JOB_ONE}.json`), '{ private malformed bytes');
    await expect(store.read(projectPath, JOB_ONE)).rejects.toMatchObject({
      code: 'invalid_job',
      message: 'Invalid presentation job record',
    });
  });

  it('ignores unrelated files and quarantines malformed JSON records from lists', async () => {
    await store.create(projectPath, job());
    const jobsDir = path.join(projectPath, 'presentation-jobs');
    await writeFile(path.join(jobsDir, 'notes.txt'), 'private notes');
    await writeFile(path.join(jobsDir, 'not-a-job.json'), JSON.stringify(job(JOB_TWO)));
    await writeFile(path.join(jobsDir, `${JOB_TWO}.json`), '{ private malformed bytes');

    expect(await store.list(projectPath)).toEqual([job()]);
    expect(warn).toHaveBeenCalledWith(
      { errorName: 'InvalidPresentationJobRecord', jobId: JOB_TWO },
      'Ignored invalid presentation job record',
    );
  });

  it('deletes only the validated job record and safely ignores a missing record', async () => {
    await store.create(projectPath, job());
    await store.create(projectPath, job(JOB_TWO));

    await store.delete(projectPath, JOB_ONE);
    await store.delete(projectPath, JOB_ONE);

    expect(await store.read(projectPath, JOB_ONE)).toBeNull();
    expect((await store.read(projectPath, JOB_TWO))?.id).toBe(JOB_TWO);
  });
});
