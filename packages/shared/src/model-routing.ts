import { z } from 'zod';

export const ModelTaskRoleSchema = z.enum([
  'video-understanding',
  'writing',
  'general',
]);
export type ModelTaskRole = z.infer<typeof ModelTaskRoleSchema>;

export const ModelCapabilitiesSchema = z.object({
  text: z.boolean(),
  image: z.boolean(),
  video: z.boolean(),
}).strict();
export type ModelCapabilities = z.infer<typeof ModelCapabilitiesSchema>;

export const ProjectModelRoutingSchema = z.object({
  video_understanding: z.string().min(1).optional(),
  writing: z.string().min(1).optional(),
  general: z.string().min(1).optional(),
}).strict().default({});
export type ProjectModelRouting = z.infer<typeof ProjectModelRoutingSchema>;

export const ModelRoutingErrorCodeSchema = z.enum([
  'model_assignment_missing',
  'model_assignment_invalid',
  'model_capability_mismatch',
  'model_unavailable',
]);
export type ModelRoutingErrorCode = z.infer<typeof ModelRoutingErrorCodeSchema>;

export const ModelProviderSchema = z.enum([
  'fake',
  'gemini',
  'anthropic',
  'claude-code',
  'codex-cli',
  'openai-compat',
]);

const ModelAssignmentIdsSchema = z.object({
  'video-understanding': z.string().min(1).optional(),
  writing: z.string().min(1).optional(),
  general: z.string().min(1).optional(),
}).strict();

export const ResolvedModelSummarySchema = z.object({
  role: ModelTaskRoleSchema,
  scope: z.enum(['global', 'project']),
  entry_id: z.string().min(1).max(200),
  provider: ModelProviderSchema,
  model: z.string().min(1).max(500),
  name: z.string().min(1).max(200),
  capabilities: ModelCapabilitiesSchema,
  ready: z.boolean(),
  readinessMessage: z.string().min(1).max(500).optional(),
}).strict();
export type ResolvedModelSummary = z.infer<typeof ResolvedModelSummarySchema>;

export const ModelRoutingErrorSummarySchema = z.object({
  role: ModelTaskRoleSchema,
  scope: z.enum(['global', 'project']),
  ready: z.literal(false),
  code: ModelRoutingErrorCodeSchema,
  message: z.string().min(1).max(500),
}).strict();
export type ModelRoutingErrorSummary = z.infer<typeof ModelRoutingErrorSummarySchema>;

export const ModelRoutingResolutionSchema = z.union([
  ResolvedModelSummarySchema,
  ModelRoutingErrorSummarySchema,
]);
export type ModelRoutingResolution = z.infer<typeof ModelRoutingResolutionSchema>;

export const ModelRoutingResponseSchema = z.object({
  assignments: ModelAssignmentIdsSchema,
  resolved: z.array(ModelRoutingResolutionSchema).length(3),
}).strict().superRefine((value, ctx) => {
  const roles = new Set(value.resolved.map((summary) => summary.role));
  if (roles.size !== ModelTaskRoleSchema.options.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['resolved'],
      message: 'Model routing responses must contain one summary per task role.',
    });
  }
});
export type ModelRoutingResponse = z.infer<typeof ModelRoutingResponseSchema>;

export const ModelRoutingUpdateSchema = z.object({
  assignments: z.object({
    'video-understanding': z.string().min(1).nullable().optional(),
    writing: z.string().min(1).nullable().optional(),
    general: z.string().min(1).nullable().optional(),
  }).strict(),
}).strict();
export type ModelRoutingUpdate = z.infer<typeof ModelRoutingUpdateSchema>;
