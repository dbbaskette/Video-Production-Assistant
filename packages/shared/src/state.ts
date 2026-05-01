import { z } from 'zod';

export const StageStatusSchema = z.enum(['pending', 'running', 'complete', 'failed']);
export type StageStatus = z.infer<typeof StageStatusSchema>;

export const ProjectStateSchema = z.object({
  ideation: StageStatusSchema.optional(),
  ingestion: StageStatusSchema.optional(),
  scripts: z.record(z.string(), StageStatusSchema).optional(),
  narration: z.record(z.string(), StageStatusSchema).optional(),
  lower_thirds: z.record(z.string(), StageStatusSchema).optional(),
  subtitles: z.record(z.string(), StageStatusSchema).optional(),
  review: StageStatusSchema.optional(),
});
export type ProjectState = z.infer<typeof ProjectStateSchema>;
