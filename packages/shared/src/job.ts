import { z } from 'zod';
import { isSafeProjectRelativePath } from './presentation.js';

export const JobStatus = z.enum([
  'pending',
  'running',
  'awaiting-input',
  'cancelling',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);
export type JobStatus = z.infer<typeof JobStatus>;

export const JobEvent = z.object({
  type: z.string().min(1).max(80),
  timestamp: z.string().datetime(),
  data: z.unknown().optional(),
});
export type JobEvent = z.infer<typeof JobEvent>;

export const JobMeta = z.object({
  /** Project this job belongs to, when applicable. Used by the client-side
      job tray to scope visibility to the current project. */
  projectId: z.string().max(120).optional(),
  /** Human-readable one-liner shown in the tray. */
  label: z.string().max(160).optional(),
  /** Frozen project revision and input fingerprint used by the worker. */
  inputRevision: z.number().int().nonnegative().optional(),
  inputFingerprint: z.string().min(1).max(128).optional(),
  idempotencyKey: z.string().min(8).max(120).optional(),
});
export type JobMeta = z.infer<typeof JobMeta>;

export const Job = z.object({
  id: z.string().uuid(),
  type: z.string().min(1).max(100),
  status: JobStatus,
  created: z.string().datetime(),
  updated: z.string().datetime(),
  events: z.array(JobEvent).max(200),
  result: z.unknown().optional(),
  error: z.string().max(300).optional(),
  failure: z.object({
    code: z.string().min(1).max(80),
    message: z.string().min(1).max(300),
    retryable: z.boolean(),
  }).optional(),
  artifacts: z.array(z.object({
    kind: z.string().min(1).max(80),
    path: z.string().min(1).max(500).refine(isSafeProjectRelativePath),
    revision: z.number().int().nonnegative().optional(),
    fingerprint: z.string().min(1).max(128).optional(),
  })).max(100).optional(),
  meta: JobMeta.optional(),
});
export type Job = z.infer<typeof Job>;
