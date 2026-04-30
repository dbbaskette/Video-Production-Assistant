import { z } from 'zod';

export const JobStatus = z.enum([
  'pending',
  'running',
  'awaiting-input',
  'completed',
  'failed',
  'cancelled',
]);
export type JobStatus = z.infer<typeof JobStatus>;

export const JobEvent = z.object({
  type: z.string(),
  timestamp: z.string(),
  data: z.unknown().optional(),
});
export type JobEvent = z.infer<typeof JobEvent>;

export const Job = z.object({
  id: z.string().uuid(),
  type: z.string(),
  status: JobStatus,
  created: z.string(),
  updated: z.string(),
  events: z.array(JobEvent),
  result: z.unknown().optional(),
  error: z.string().optional(),
});
export type Job = z.infer<typeof Job>;
