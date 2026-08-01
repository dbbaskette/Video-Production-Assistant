import { z } from 'zod';
import { SceneTypeSchema } from './storyboard.js';

export const AgentCaptureSettingsSchema = z.object({
  targetApplication: z.string().default(''),
  startingUrl: z.string().url().or(z.literal('')).default(''),
  targetKind: z.enum(['window', 'screen']).default('window'),
  width: z.number().int().positive().default(1920),
  height: z.number().int().positive().default(1080),
  fps: z.number().int().positive().max(60).default(30),
  cursor: z.boolean().default(true),
  microphone: z.boolean().default(false),
  camera: z.boolean().default(false),
  systemAudio: z.boolean().default(false),
});
export type AgentCaptureSettings = z.infer<typeof AgentCaptureSettingsSchema>;

export const AgentRecordingStepSchema = z.object({
  index: z.number().int().nonnegative(),
  action: z.string().min(1),
  note: z.string().optional(),
  checkpoint: z.string().optional(),
});

export const AgentRecordingPlanSchema = z.object({
  version: z.literal(1),
  projectId: z.string(),
  projectName: z.string(),
  projectObjective: z.string().optional(),
  sceneId: z.string(),
  sceneName: z.string(),
  sceneType: SceneTypeSchema,
  sceneIntent: z.string().optional(),
  sourceFingerprint: z.string(),
  stale: z.boolean().default(false),
  capture: AgentCaptureSettingsSchema,
  steps: z.array(AgentRecordingStepSchema),
  preconditions: z.array(z.string()),
  checkpoints: z.array(z.string()),
  rehearseFirst: z.boolean().default(true),
  leadInSec: z.number().nonnegative().default(2),
  tailSec: z.number().nonnegative().default(2),
  failurePolicy: z.literal('stop-and-do-not-attach'),
  attachmentEndpoint: z.string(),
  updatedAt: z.string().datetime(),
});
export type AgentRecordingPlan = z.infer<typeof AgentRecordingPlanSchema>;

export const AgentRecordingPlanUpdateSchema = z.object({
  capture: AgentCaptureSettingsSchema,
  steps: z.array(AgentRecordingStepSchema),
  preconditions: z.array(z.string()),
  checkpoints: z.array(z.string()),
  rehearseFirst: z.literal(true),
  leadInSec: z.number().nonnegative().max(10),
  tailSec: z.number().nonnegative().max(10),
});
export type AgentRecordingPlanUpdate = z.infer<typeof AgentRecordingPlanUpdateSchema>;

export const CapSetupStateSchema = z.enum([
  'not-installed', 'installing', 'needs-permission', 'ready', 'error',
]);
export type CapSetupState = z.infer<typeof CapSetupStateSchema>;

export const CapSetupStatusSchema = z.object({
  state: CapSetupStateSchema,
  installed: z.boolean(),
  cliPath: z.string().optional(),
  version: z.string().optional(),
  captureReady: z.boolean(),
  missingPermissions: z.array(z.enum(['screen-recording', 'accessibility'])),
  targetCount: z.number().int().nonnegative().default(0),
  installationId: z.string().uuid().optional(),
  message: z.string().optional(),
  updatedAt: z.string().datetime(),
});
export type CapSetupStatus = z.infer<typeof CapSetupStatusSchema>;

export const AgentRehearsalEvidenceSchema = z.object({
  success: z.boolean(),
  targetApplication: z.string(),
  windowTitle: z.string(),
  windowBounds: z.object({
    x: z.number(),
    y: z.number(),
    width: z.number().positive(),
    height: z.number().positive(),
  }),
  completedStepIndexes: z.array(z.number().int().nonnegative()),
  checkpoints: z.array(z.object({
    description: z.string(),
    passed: z.boolean(),
    detail: z.string().optional(),
  })),
  resetConfirmed: z.boolean(),
  diagnostic: z.string().max(2000).optional(),
  /** Server-authored snapshot of the reviewed settings bound to this rehearsal. */
  reviewedCapture: AgentCaptureSettingsSchema.optional(),
  /** Server-authored snapshot of the reviewed actions bound to this rehearsal. */
  reviewedSteps: z.array(AgentRecordingStepSchema).optional(),
});
export type AgentRehearsalEvidence = z.infer<typeof AgentRehearsalEvidenceSchema>;

export const AgentRecordingRehearseRequestSchema = AgentRecordingPlanUpdateSchema;
export type AgentRecordingRehearseRequest = z.infer<typeof AgentRecordingRehearseRequestSchema>;

export const AgentRecordingConfirmRequestSchema = z.object({
  confirmed: z.literal(true),
  planFingerprint: z.string().min(1),
});
export type AgentRecordingConfirmRequest = z.infer<typeof AgentRecordingConfirmRequestSchema>;

export const AgentRecordingSessionStateSchema = z.enum([
  'rehearsing', 'awaiting_confirmation', 'recording', 'exporting', 'attaching', 'completed', 'failed', 'interrupted',
]);
export type AgentRecordingSessionState = z.infer<typeof AgentRecordingSessionStateSchema>;

export const AgentRecordingSessionSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string(),
  sceneId: z.string(),
  state: AgentRecordingSessionStateSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  message: z.string().optional(),
  phase: z.string().optional(),
  planFingerprint: z.string().min(1).optional(),
  rehearsal: AgentRehearsalEvidenceSchema.optional(),
  confirmedCapture: z.boolean().optional(),
});
export type AgentRecordingSession = z.infer<typeof AgentRecordingSessionSchema>;

export const AgentRecordingSessionCreateSchema = z.object({ state: z.literal('rehearsing') });

export const RecordingProvenanceSchema = z.object({
  source_kind: z.enum(['manual', 'cap-agent', 'bulk', 'split']).default('manual'),
  capture_session_id: z.string().uuid().optional(),
  captured_at: z.string().datetime().optional(),
}).superRefine((value, ctx) => {
  if (value.source_kind === 'cap-agent' && !value.capture_session_id) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['capture_session_id'], message: 'Cap agent recordings require a capture session ID.' });
  }
});
export type RecordingProvenance = z.infer<typeof RecordingProvenanceSchema>;
