import { z } from 'zod';
import { AssetIdSchema } from './asset.js';
import { ClipInstanceIdSchema } from './composition.js';
import { NormalizedRectSchema } from './visual-evidence.js';

export const FeedbackNoteSchema = z.object({
  id: z.string().regex(/^note_[A-Za-z0-9-]{8,80}$/),
  created_at: z.string().datetime(),
  created_revision: z.number().int().nonnegative(),
  scene_id: z.string().min(1).max(120),
  clip_instance_id: ClipInstanceIdSchema,
  source_asset_id: AssetIdSchema,
  source_in_ms: z.number().int().nonnegative(),
  source_out_ms: z.number().int().positive(),
  rect: NormalizedRectSchema.optional(),
  text: z.string().trim().min(1).max(4_000),
  status: z.enum(['pending', 'claimed', 'resolved', 'failed', 'reanchor-required']).default('pending'),
  claimed_by: z.string().min(1).max(200).optional(),
  claimed_at: z.string().datetime().optional(),
  resolving_revision: z.number().int().nonnegative().optional(),
  resolution: z.string().trim().min(1).max(4_000).optional(),
  failure: z.string().trim().min(1).max(1_000).optional(),
}).strict().superRefine((note, ctx) => {
  if (note.source_out_ms <= note.source_in_ms) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['source_out_ms'], message: 'note out must be after in' });
  if (note.status === 'resolved' && note.resolving_revision === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['resolving_revision'], message: 'resolved notes require a revision' });
});
export type FeedbackNote = z.infer<typeof FeedbackNoteSchema>;
