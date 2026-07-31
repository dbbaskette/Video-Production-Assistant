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

export const AgentRecordingSessionStateSchema = z.enum([
  'rehearsing', 'recording', 'exporting', 'attaching', 'completed', 'failed', 'interrupted',
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
  recordingId: z.string().optional(),
});
export type AgentRecordingSession = z.infer<typeof AgentRecordingSessionSchema>;

export const AgentRecordingSessionCreateSchema = z.object({ state: z.literal('rehearsing') });
export const AgentRecordingSessionUpdateSchema = z.object({
  state: AgentRecordingSessionStateSchema.exclude(['rehearsing']),
  message: z.string().max(2000).optional(),
  recordingId: z.string().max(500).optional(),
  capProjectPath: z.string().max(4000).optional(),
  exportPath: z.string().max(4000).optional(),
});

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
