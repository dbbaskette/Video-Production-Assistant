import { z } from 'zod';
import { AssetIdSchema } from './asset.js';
import { AudioMixRoleSchema, AudioMixSettingsSchema, ClipInstanceIdSchema } from './composition.js';
import { NormalizedRectSchema, VisualEffectSchema } from './visual-evidence.js';

export const AssistanceProvenanceSchema = z.enum(['metadata', 'observed', 'inferred']);
export type AssistanceProvenance = z.infer<typeof AssistanceProvenanceSchema>;

export const SourceCitationSchema = z.object({
  scene_id: z.string().min(1),
  source_asset_id: AssetIdSchema,
  source_in_ms: z.number().int().nonnegative(),
  source_out_ms: z.number().int().positive(),
  evidence: z.enum(['transcript', 'frame', 'contact-sheet', 'capture-metadata']),
  excerpt: z.string().trim().min(1).max(500).optional(),
  confidence: z.number().min(0).max(1),
  provenance: AssistanceProvenanceSchema,
}).strict();
export type SourceCitation = z.infer<typeof SourceCitationSchema>;

const EditorialRangeFields = {
  id: z.string().regex(/^range_[A-Za-z0-9-]{8,80}$/),
  kind: z.enum(['keep', 'highlight']),
  clip_instance_id: ClipInstanceIdSchema,
  source_asset_id: AssetIdSchema,
  source_in_ms: z.number().int().nonnegative(),
  source_out_ms: z.number().int().positive(),
  title: z.string().trim().min(1).max(200),
  rationale: z.string().trim().min(1).max(1_000),
};

export const EditorialRangeDraftSchema = z.object(EditorialRangeFields).strict().superRefine((range, ctx) => {
  if (range.source_out_ms <= range.source_in_ms) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['source_out_ms'], message: 'range out must be after in' });
});

export const EditorialRangeSchema = z.object({
  ...EditorialRangeFields,
  accepted_at: z.string().datetime(),
}).strict().superRefine((range, ctx) => {
  if (range.source_out_ms <= range.source_in_ms) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['source_out_ms'], message: 'range out must be after in' });
});
export type EditorialRange = z.infer<typeof EditorialRangeSchema>;

const BaseProposal = {
  id: z.string().regex(/^proposal_[A-Za-z0-9-]{8,80}$/),
  scene_id: z.string().min(1),
  title: z.string().min(1).max(200),
  rationale: z.string().min(1).max(2_000),
  confidence: z.number().min(0).max(1),
  provenance: AssistanceProvenanceSchema,
  citations: z.array(SourceCitationSchema).min(1).max(50),
  status: z.enum(['pending', 'accepted']).default('pending'),
  warnings: z.array(z.string().max(500)).max(20).default([]),
};

export const AssistanceProposalSchema = z.discriminatedUnion('kind', [
  z.object({ ...BaseProposal, kind: z.literal('trim'), clip_id: ClipInstanceIdSchema, source_in_ms: z.number().int().nonnegative(), source_out_ms: z.number().int().positive(), omitted_text: z.string().max(2_000).optional() }).strict(),
  z.object({ ...BaseProposal, kind: z.literal('cleanup'), clip_id: ClipInstanceIdSchema, remove_in_ms: z.number().int().nonnegative(), remove_out_ms: z.number().int().positive(), label: z.string().max(200) }).strict(),
  z.object({ ...BaseProposal, kind: z.literal('audio'), role: AudioMixRoleSchema, settings: AudioMixSettingsSchema }).strict(),
  z.object({ ...BaseProposal, kind: z.literal('highlight'), range: EditorialRangeDraftSchema }).strict(),
  z.object({ ...BaseProposal, kind: z.literal('focus'), effect: VisualEffectSchema, suggested_rect: NormalizedRectSchema }).strict(),
  z.object({ ...BaseProposal, kind: z.literal('callout'), effect: VisualEffectSchema, suggested_rect: NormalizedRectSchema }).strict(),
  z.object({ ...BaseProposal, kind: z.literal('sensitive'), effect: VisualEffectSchema, suggested_rect: NormalizedRectSchema }).strict(),
]);
export type AssistanceProposal = z.infer<typeof AssistanceProposalSchema>;

export const AssistanceResponseSchema = z.object({
  revision: z.number().int().nonnegative(),
  current_duration_ms: z.number().int().nonnegative(),
  target_duration_ms: z.number().int().positive(),
  projected_duration_ms: z.number().int().nonnegative(),
  tolerance_met: z.boolean(),
  proposals: z.array(AssistanceProposalSchema),
  blockers: z.array(z.string()),
}).strict();
export type AssistanceResponse = z.infer<typeof AssistanceResponseSchema>;
