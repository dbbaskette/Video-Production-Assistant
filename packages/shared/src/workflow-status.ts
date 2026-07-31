import { z } from 'zod';

export const WorkflowStepKeySchema = z.enum([
  'storyboard',
  'recordings',
  'script',
  'narration',
  'lower-thirds',
  'render',
  'review',
]);
export type WorkflowStepKey = z.infer<typeof WorkflowStepKeySchema>;

export const WorkflowStepStateSchema = z.enum([
  'blocked',
  'ready',
  'in_progress',
  'complete',
  'stale',
  'optional',
]);
export type WorkflowStepState = z.infer<typeof WorkflowStepStateSchema>;

export const WorkflowActionKeySchema = z.enum([
  'open_storyboard',
  'open_recordings',
  'open_script',
  'open_narration',
  'open_lower_thirds',
  'open_render',
  'open_review',
  'open_scene_recording',
  'render_again',
]);
export type WorkflowActionKey = z.infer<typeof WorkflowActionKeySchema>;

export const WorkflowIssueSchema = z.object({
  id: z.string().min(1),
  severity: z.enum(['blocker', 'warning']),
  phase: WorkflowStepKeySchema,
  code: z.string().min(1),
  message: z.string().min(1),
  recommendation: z.string().min(1),
  action: WorkflowActionKeySchema,
  sceneId: z.string().optional(),
  sceneName: z.string().optional(),
  sceneNumber: z.number().int().positive().optional(),
});
export type WorkflowIssue = z.infer<typeof WorkflowIssueSchema>;

export const WorkflowStepSchema = z.object({
  key: WorkflowStepKeySchema,
  label: z.string(),
  state: WorkflowStepStateSchema,
  summary: z.string(),
  completed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;

export const WorkflowNextActionSchema = z.object({
  key: WorkflowActionKeySchema,
  label: z.string(),
  summary: z.string(),
  sceneId: z.string().optional(),
});
export type WorkflowNextAction = z.infer<typeof WorkflowNextActionSchema>;

export const RenderFreshnessSchema = z.object({
  state: z.enum(['missing', 'current', 'stale', 'in_progress']),
  reason: z.string().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  modifiedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
});
export type RenderFreshness = z.infer<typeof RenderFreshnessSchema>;

export const RenderPreflightSchema = z.object({
  ready: z.boolean(),
  readyScenes: z.number().int().nonnegative(),
  totalScenes: z.number().int().nonnegative(),
  blockers: z.array(WorkflowIssueSchema),
  warnings: z.array(WorkflowIssueSchema),
  output: RenderFreshnessSchema,
});
export type RenderPreflight = z.infer<typeof RenderPreflightSchema>;

export const WorkflowStatusSchema = z.object({
  projectId: z.string(),
  computedAt: z.string().datetime(),
  steps: z.array(WorkflowStepSchema).length(7),
  nextAction: WorkflowNextActionSchema,
  issues: z.array(WorkflowIssueSchema),
  counts: z.object({ blockers: z.number().int().nonnegative(), warnings: z.number().int().nonnegative() }),
  progress: z.object({ completed: z.number().int().nonnegative(), total: z.number().int().positive(), percent: z.number().min(0).max(100) }),
  render: RenderPreflightSchema,
});
export type WorkflowStatus = z.infer<typeof WorkflowStatusSchema>;
