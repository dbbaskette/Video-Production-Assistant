import { z } from 'zod';

export const PRESENTATION_SCHEMA_VERSION = 1;
export const PRESENTATION_SLIDE_BRIEF_SCHEMA_VERSION = 1;
export const PRESENTATION_SLIDE_BRIEF_PROMPT_VERSION = 1;
export const PRESENTATION_NARRATION_PROMPT_VERSION = 1;

const jobStatuses = ['processing', 'ready', 'partial', 'failed'] as const;
const jobStages = [
  'uploading',
  'processing-slides',
  'creating-scenes',
  'drafting-narration',
  'ready',
  'failed',
] as const;
const pageAiStatuses = ['not-requested', 'pending', 'ready', 'failed', 'preserved-user-edit'] as const;

/** Project-owned paths only; persisted presentation records never contain local paths. */
export function isSafeProjectRelativePath(path: string): boolean {
  if (path.startsWith('/') || path.startsWith('\\') || path.includes('\\') || /^[A-Za-z]:[\\/]/.test(path)) {
    return false;
  }
  const segments = path.split('/');
  return !segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..');
}

const SafeProjectRelativePathSchema = z.string().min(1).max(1_024).superRefine((path, ctx) => {
  if (!isSafeProjectRelativePath(path)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Path must be a safe project-relative path' });
  }
});

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const ModelProvenanceSchema = z.object({
  entry_id: z.string().min(1).max(200),
  model: z.string().min(1).max(500),
}).strict();

const GeminiModelProvenanceSchema = ModelProvenanceSchema.extend({
  provider: z.literal('gemini'),
}).strict();

export const PresentationJobStatusSchema = z.enum(jobStatuses);
export type PresentationJobStatus = z.infer<typeof PresentationJobStatusSchema>;

export const PresentationJobStageSchema = z.enum(jobStages);
export type PresentationJobStage = z.infer<typeof PresentationJobStageSchema>;

export const PresentationPageAiStatusSchema = z.enum(pageAiStatuses);
export type PresentationPageAiStatus = z.infer<typeof PresentationPageAiStatusSchema>;

export const PresentationSourceSchema = z.object({
  presentation_id: z.string().uuid(),
  page_number: z.number().int().positive(),
  page_count: z.number().int().positive().max(200),
  image: SafeProjectRelativePathSchema,
  hold_duration_sec: z.number().min(1).max(3600).default(5),
}).strict().superRefine((value, ctx) => {
  if (value.page_number > value.page_count) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['page_number'],
      message: 'page_number must not exceed page_count',
    });
  }
});
export type PresentationSource = z.infer<typeof PresentationSourceSchema>;

export const PresentationPageRecordSchema = z.object({
  page_number: z.number().int().positive().max(200),
  scene_id: z.string().min(1).max(120),
  image: SafeProjectRelativePathSchema,
  clip: SafeProjectRelativePathSchema,
  extracted_text: z.string().max(20_000),
  baseline: z.object({
    name: z.string().min(1).max(200),
    description: z.string().max(4_000),
    narration_script: z.null(),
  }).strict(),
  analysis_status: PresentationPageAiStatusSchema,
  script_status: PresentationPageAiStatusSchema,
  brief: SafeProjectRelativePathSchema.optional(),
  draft: SafeProjectRelativePathSchema.optional(),
}).strict();
export type PresentationPageRecord = z.infer<typeof PresentationPageRecordSchema>;

const PresentationManifestBaseSchema = z.object({
  schema_version: z.literal(PRESENTATION_SCHEMA_VERSION),
  id: z.string().uuid(),
  project_id: z.string().uuid(),
  display_name: z.string().min(1).max(255),
  source_sha256: Sha256Schema,
  size_bytes: z.number().int().positive(),
  page_count: z.number().int().positive().max(200),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  generate_narration: z.boolean(),
  visual_model: ModelProvenanceSchema.optional(),
  writing_model: ModelProvenanceSchema.optional(),
  pages: z.array(PresentationPageRecordSchema).min(1).max(200),
}).strict();

export const PresentationManifestSchema = PresentationManifestBaseSchema.superRefine((value, ctx) => {
  if (value.pages.length !== value.page_count) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['page_count'],
      message: 'page_count must equal the number of pages',
    });
  }
  value.pages.forEach((page, index) => {
    if (page.page_number !== index + 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['pages', index, 'page_number'],
        message: 'pages must be ordered by contiguous one-based page_number',
      });
    }
  });
});
export type PresentationManifest = z.infer<typeof PresentationManifestSchema>;

export const PresentationJobSchema = z.object({
  schema_version: z.literal(PRESENTATION_SCHEMA_VERSION),
  id: z.string().uuid(),
  project_id: z.string().uuid(),
  filename: z.string().min(1).max(255),
  status: PresentationJobStatusSchema,
  stage: PresentationJobStageSchema,
  generate_narration: z.boolean(),
  page_count: z.number().int().nonnegative().max(200),
  processed_pages: z.number().int().nonnegative().max(200),
  analyzed_pages: z.number().int().nonnegative().max(200),
  scripted_pages: z.number().int().nonnegative().max(200),
  remaining_scene_count: z.number().int().nonnegative().max(200),
  deterministic_commit: z.enum(['uncommitted', 'commit-pending', 'committed']).optional(),
  deletion_pending: z.boolean().optional(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  error: z.object({
    code: z.string().min(1).max(120),
    message: z.string().min(1).max(300),
  }).strict().optional(),
}).strict().superRefine((value, ctx) => {
  for (const field of ['processed_pages', 'analyzed_pages', 'scripted_pages'] as const) {
    if (value[field] > value.page_count) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `${field} exceeds page_count` });
    }
  }
});
export type PresentationJob = z.infer<typeof PresentationJobSchema>;

const BriefListSchema = z.array(z.string().min(1).max(1_000)).max(50);

export const PresentationSlideBriefSchema = z.object({
  schema_version: z.literal(PRESENTATION_SLIDE_BRIEF_SCHEMA_VERSION),
  presentation_id: z.string().uuid(),
  page_number: z.number().int().positive().max(200),
  image_sha256: Sha256Schema,
  extracted_text_sha256: Sha256Schema,
  model: GeminiModelProvenanceSchema,
  prompt_version: z.literal(PRESENTATION_SLIDE_BRIEF_PROMPT_VERSION),
  visual_summary: z.string().min(1).max(4_000),
  detected_title: z.string().max(200),
  key_points: BriefListSchema,
  visual_elements: BriefListSchema,
  quantitative_claims: BriefListSchema,
  uncertain_content: BriefListSchema,
}).strict();
export type PresentationSlideBrief = z.infer<typeof PresentationSlideBriefSchema>;

export const PresentationDraftSchema = z.object({
  schema_version: z.literal(PRESENTATION_SCHEMA_VERSION),
  presentation_id: z.string().uuid(),
  page_number: z.number().int().positive().max(200),
  brief_fingerprint: Sha256Schema,
  model: ModelProvenanceSchema,
  script: z.string().min(1).max(12_000),
  created_at: z.string().datetime(),
  applied: z.boolean(),
}).strict();
export type PresentationDraft = z.infer<typeof PresentationDraftSchema>;
