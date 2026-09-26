import { z } from 'zod';
import { AssetIdSchema, AssetSourceRoleSchema } from './asset.js';

export const BrowserCaptureTrackRoleSchema = z.enum(['screen', 'camera', 'microphone', 'system-audio']);
export type BrowserCaptureTrackRole = z.infer<typeof BrowserCaptureTrackRoleSchema>;

export const BrowserCaptureTrackSchema = z.object({
  id: z.string().regex(/^track_[a-zA-Z0-9-]{8,80}$/),
  role: BrowserCaptureTrackRoleSchema,
  kind: z.enum(['video', 'audio']),
  mime_type: z.string().min(1).max(120),
  timing_origin_ms: z.number().int().nonnegative(),
  shared_audio_available: z.boolean().optional(),
  chunks: z.number().int().nonnegative().default(0),
  bytes: z.number().int().nonnegative().default(0),
  asset_id: AssetIdSchema.optional(),
}).strict();
export type BrowserCaptureTrack = z.infer<typeof BrowserCaptureTrackSchema>;

export const BrowserCaptureStatusSchema = z.enum([
  'recording',
  'incomplete',
  'assembling',
  'completed',
  'failed',
  'cancelled',
]);
export type BrowserCaptureStatus = z.infer<typeof BrowserCaptureStatusSchema>;

export const BrowserCaptureSessionSchema = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  project_id: z.string().uuid(),
  scene_id: z.string().min(1),
  status: BrowserCaptureStatusSchema,
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  common_clock_origin_ms: z.number().int().nonnegative(),
  tracks: z.array(BrowserCaptureTrackSchema).min(1).max(4),
  failure: z.object({
    code: z.string().min(1).max(80),
    message: z.string().min(1).max(300),
    retryable: z.boolean(),
  }).optional(),
}).strict().superRefine((session, ctx) => {
  const roles = new Set<string>();
  for (const [index, track] of session.tracks.entries()) {
    if (roles.has(track.role)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['tracks', index, 'role'], message: 'capture track roles must be unique' });
    }
    roles.add(track.role);
  }
  if (!roles.has('screen')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['tracks'], message: 'browser capture requires a screen track' });
  }
});
export type BrowserCaptureSession = z.infer<typeof BrowserCaptureSessionSchema>;

export const BrowserCaptureCreateSchema = z.object({
  sceneId: z.string().min(1),
  commonClockOriginMs: z.number().int().nonnegative(),
  tracks: z.array(z.object({
    id: z.string().regex(/^track_[a-zA-Z0-9-]{8,80}$/),
    role: BrowserCaptureTrackRoleSchema,
    kind: z.enum(['video', 'audio']),
    mimeType: z.string().min(1).max(120),
    timingOriginMs: z.number().int().nonnegative(),
    sharedAudioAvailable: z.boolean().optional(),
  }).strict()).min(1).max(4),
}).strict().superRefine((capture, ctx) => {
  const roles = new Set<string>();
  for (const [index, track] of capture.tracks.entries()) {
    if (roles.has(track.role)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['tracks', index, 'role'], message: 'capture track roles must be unique' });
    }
    roles.add(track.role);
  }
  if (!roles.has('screen')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['tracks'], message: 'browser capture requires a screen track' });
  }
});
export type BrowserCaptureCreate = z.infer<typeof BrowserCaptureCreateSchema>;

export const BrowserCaptureChunkAckSchema = z.object({
  sessionId: z.string().uuid(),
  trackId: z.string(),
  sequence: z.number().int().nonnegative(),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().positive(),
  reused: z.boolean(),
});
export type BrowserCaptureChunkAck = z.infer<typeof BrowserCaptureChunkAckSchema>;

export function captureRoleToAssetRole(role: BrowserCaptureTrackRole): z.infer<typeof AssetSourceRoleSchema> {
  return role;
}
