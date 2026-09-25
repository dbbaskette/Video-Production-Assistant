import type { Job, JobMeta } from '@vpa/shared';
import { JobCapacityError, JobIdempotencyError, JobPersistenceError, jobQueue } from './job-queue.js';

export class InvalidIdempotencyKeyError extends Error {
  readonly code = 'invalid_idempotency_key';
}

export function readIdempotencyKey(headers: Record<string, unknown>): string | undefined {
  const value = headers['idempotency-key'];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length < 8 || value.length > 120) {
    throw new InvalidIdempotencyKeyError('Idempotency-Key must contain 8 to 120 characters.');
  }
  return value;
}

export async function createSubmittedJob(
  type: string,
  meta: JobMeta,
  idempotencyKey?: string,
): Promise<{ job: Job; reused: boolean }> {
  const prior = idempotencyKey ? jobQueue.findByIdempotencyKey(idempotencyKey) : undefined;
  const job = await jobQueue.createDurable(type, {
    ...meta,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  });
  return { job, reused: prior?.id === job.id };
}

export function jobSubmissionFailure(error: unknown): { status: number; body: { error: string; code: string } } | null {
  if (error instanceof InvalidIdempotencyKeyError) {
    return { status: 400, body: { error: error.message, code: error.code } };
  }
  if (error instanceof JobIdempotencyError) {
    return { status: 409, body: { error: error.message, code: error.code } };
  }
  if (error instanceof JobCapacityError) {
    return { status: 429, body: { error: error.message, code: error.code } };
  }
  if (error instanceof JobPersistenceError) {
    return { status: 507, body: { error: error.message, code: error.code } };
  }
  return null;
}
