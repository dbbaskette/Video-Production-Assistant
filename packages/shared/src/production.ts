import { z } from 'zod';
import { SceneSchema } from './storyboard.js';

export const ProposalOperationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('add'), scene: SceneSchema, index: z.number().int().nonnegative().optional() }).strict(),
  z.object({ type: z.literal('update'), sceneId: z.string().min(1), patch: z.object({ name: z.string().trim().min(1).max(120).optional(), description: z.string().trim().max(4_000).optional(), type: z.enum(['desktop', 'terminal', 'browser', 'slide']).optional() }).strict() }).strict(),
  z.object({ type: z.literal('delete'), sceneId: z.string().min(1) }).strict(),
  z.object({ type: z.literal('reorder'), sceneIds: z.array(z.string().min(1)).min(1).max(500) }).strict(),
]);
export type ProposalOperation = z.infer<typeof ProposalOperationSchema>;

export const ProductionRecipeSchema = z.enum(['clean-walkthrough', 'feature-demo', 'revise-this-draft']);
export type ProductionRecipe = z.infer<typeof ProductionRecipeSchema>;

export const ProductionRecipeInspectionSchema = z.object({
  recipe: ProductionRecipeSchema,
  revision: z.number().int().nonnegative(),
  supported: z.boolean(),
  sources: z.array(z.object({ sceneId: z.string(), source: z.string(), sourceRole: z.string() })),
  blockers: z.array(z.string()),
  effects: z.array(z.string()),
}).strict();
export type ProductionRecipeInspection = z.infer<typeof ProductionRecipeInspectionSchema>;

export const PilotCaseSchema = z.object({
  id: z.string(),
  kind: z.enum(['narrated-walkthrough', 'screen-only-feature-demo', 'webcam-demo', 'imported-take', 'multi-clip-redaction']),
  requiredRecipe: ProductionRecipeSchema,
  requiresFeedbackRevision: z.literal(true),
  requiresSourceRestore: z.literal(true),
  requiresPlayableExport: z.literal(true),
}).strict();
export type PilotCase = z.infer<typeof PilotCaseSchema>;

export const PilotResultSchema = z.object({
  caseId: z.string(),
  hands_on_minutes: z.number().nonnegative(),
  editorial_accuracy: z.number().min(0).max(1),
  target_length_tradeoffs: z.string().max(4_000),
  omissions: z.array(z.string().max(1_000)),
  browser_version: z.string().min(1),
  device_version: z.string().min(1),
  codex_draft_revision: z.number().int().nonnegative(),
  feedback_revision: z.number().int().nonnegative(),
  restore_revision: z.number().int().nonnegative(),
  artifact_id: z.string().min(1),
  evidence: z.object({
    automated_test: z.string().min(1),
    playable_probe: z.string().min(1),
    source_preserved: z.literal(true),
  }).strict(),
}).strict();
export type PilotResult = z.infer<typeof PilotResultSchema>;

export const PilotEvaluationSchema = z.object({
  version: z.literal(1),
  verified_at: z.string().datetime(),
  fields: z.array(z.string().min(1)),
  cases: z.array(PilotCaseSchema).length(5),
  results: z.array(PilotResultSchema).length(5),
}).strict().superRefine((evaluation, context) => {
  const caseIds = new Set(evaluation.cases.map((pilot) => pilot.id));
  const resultIds = evaluation.results.map((result) => result.caseId);
  if (new Set(resultIds).size !== resultIds.length || resultIds.some((id) => !caseIds.has(id)) || resultIds.length !== caseIds.size) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['results'], message: 'results must contain exactly one record for each pilot case' });
  }
}).describe('Completed five-project production pilot evidence');
export type PilotEvaluation = z.infer<typeof PilotEvaluationSchema>;
