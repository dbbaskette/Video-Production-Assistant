import { z } from 'zod';
import { AssetIdSchema } from './asset.js';

export const VariantIdSchema = z.string().regex(/^variant_[A-Za-z0-9-]{8,80}$/);
export const VariantAspectRatioSchema = z.enum(['16:9', '1:1', '9:16']);
export type VariantAspectRatio = z.infer<typeof VariantAspectRatioSchema>;
export const VariantCropSchema = z.object({
  mode: z.enum(['contain', 'cover']),
  focus_x: z.number().min(0).max(1).default(0.5),
  focus_y: z.number().min(0).max(1).default(0.5),
}).strict();
export const VariantSafeAreaSchema = z.object({
  top: z.number().min(0).max(0.3).default(0.05),
  right: z.number().min(0).max(0.3).default(0.05),
  bottom: z.number().min(0).max(0.3).default(0.05),
  left: z.number().min(0).max(0.3).default(0.05),
}).strict();

export const VariantRangeRefSchema = z.object({
  scene_id: z.string().min(1),
  range_id: z.string().regex(/^range_[A-Za-z0-9-]{8,80}$/),
}).strict();

export const LocalizedCaptionSchema = z.object({
  id: z.string().regex(/^caption_[A-Za-z0-9-]{8,80}$/),
  scene_id: z.string().min(1),
  source_asset_id: AssetIdSchema,
  source_in_ms: z.number().int().nonnegative(),
  source_out_ms: z.number().int().positive(),
  source_text: z.string().min(1).max(4_000),
  text: z.string().min(1).max(8_000),
  source_language: z.string().min(2).max(35),
  target_language: z.string().min(2).max(35),
  provider: z.string().min(1).max(100),
  model: z.string().min(1).max(200),
  estimated_cost_usd: z.number().nonnegative().default(0),
  pronunciation_notes: z.string().max(2_000).default(''),
  accepted: z.boolean().default(false),
}).strict().superRefine((caption, ctx) => {
  if (caption.source_out_ms <= caption.source_in_ms) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['source_out_ms'], message: 'caption out must be after in' });
});

export const VariantNarrationReplacementSchema = z.object({
  asset_id: AssetIdSchema,
  source_language: z.string().min(2).max(35),
  target_language: z.string().min(2).max(35),
  duration_ms: z.number().int().positive(),
  provider: z.string().min(1).max(100),
  model: z.string().min(1).max(200),
  estimated_cost_usd: z.number().nonnegative().default(0),
  pronunciation_notes: z.string().max(2_000).default(''),
  accepted: z.boolean().default(false),
}).strict();

const EditableVariantFields = {
  id: VariantIdSchema,
  name: z.string().trim().min(1).max(120),
  aspect_ratio: VariantAspectRatioSchema,
  crop: VariantCropSchema,
  safe_area: VariantSafeAreaSchema,
  selected_ranges: z.array(VariantRangeRefSchema).max(500).default([]),
  source_language: z.string().min(2).max(35).default('en'),
  target_language: z.string().min(2).max(35).nullable().default(null),
  captions: z.array(LocalizedCaptionSchema).max(5_000).default([]),
  replace_narration: z.boolean().default(false),
  narration_replacement: VariantNarrationReplacementSchema.nullable().default(null),
};

export const OutputVariantDraftSchema = z.object(EditableVariantFields).strict();
export type OutputVariantDraft = z.infer<typeof OutputVariantDraftSchema>;

export const OutputVariantSchema = z.object({
  version: z.literal(1),
  ...EditableVariantFields,
  source_revision: z.number().int().nonnegative(),
  source_brand: z.object({ id: z.string().min(1), applied_version: z.number().int().positive() }).strict().nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
}).strict();
export type OutputVariant = z.infer<typeof OutputVariantSchema>;

export const VariantStoreSchema = z.object({
  version: z.literal(1),
  variants: z.array(OutputVariantSchema),
}).strict();

export const VariantValidationSchema = z.object({
  variant: OutputVariantSchema,
  current_revision: z.number().int().nonnegative(),
  stale: z.boolean(),
  dimensions: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).strict(),
  blockers: z.array(z.string()),
  warnings: z.array(z.string()),
  estimated_cost_usd: z.number().nonnegative(),
}).strict();
export type VariantValidation = z.infer<typeof VariantValidationSchema>;
