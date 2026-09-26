import { z } from 'zod';
import { AssetIdSchema, AssetSourceRoleSchema } from './asset.js';

export const ClipInstanceIdSchema = z.string().regex(/^clip_[a-zA-Z0-9-]{8,80}$/);
export type ClipInstanceId = z.infer<typeof ClipInstanceIdSchema>;

export const LinkedTrackSchema = z.object({
  asset_id: AssetIdSchema,
  role: AssetSourceRoleSchema,
  /** Offset from the primary source clock. Positive values start later. */
  source_offset_ms: z.number().int().min(-1_200_000).max(1_200_000).default(0),
}).strict();
export type LinkedTrack = z.infer<typeof LinkedTrackSchema>;

export const CompositionClipSchema = z.object({
  id: ClipInstanceIdSchema,
  source_asset_id: AssetIdSchema,
  source_role: z.enum(['screen', 'camera', 'image']).default('screen'),
  source_in_ms: z.number().int().nonnegative(),
  source_out_ms: z.number().int().positive(),
  timeline_start_ms: z.number().int().nonnegative(),
  linked_tracks: z.array(LinkedTrackSchema).max(10).default([]),
}).strict().superRefine((clip, ctx) => {
  if (clip.source_out_ms <= clip.source_in_ms) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['source_out_ms'], message: 'source_out_ms must be after source_in_ms' });
  }
  const roles = new Set<string>();
  const assets = new Set<string>([clip.source_asset_id]);
  for (const [index, track] of clip.linked_tracks.entries()) {
    if (roles.has(track.role)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['linked_tracks', index, 'role'], message: 'linked track roles must be unique per clip' });
    }
    roles.add(track.role);
    if (assets.has(track.asset_id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['linked_tracks', index, 'asset_id'], message: 'a source asset may only be included once per clip' });
    }
    assets.add(track.asset_id);
  }
});
export type CompositionClip = z.infer<typeof CompositionClipSchema>;

export const AudioMixRoleSchema = z.enum([
  'original',
  'system-audio',
  'microphone',
  'camera',
  'narration',
  'music',
]);
export type AudioMixRole = z.infer<typeof AudioMixRoleSchema>;

export const AudioMixSettingsSchema = z.object({
  gain_db: z.number().min(-60).max(12).default(0),
  mute: z.boolean().default(false),
  fade_in_ms: z.number().int().min(0).max(30_000).default(0),
  fade_out_ms: z.number().int().min(0).max(30_000).default(0),
}).strict();
export type AudioMixSettings = z.infer<typeof AudioMixSettingsSchema>;

export const AudioMixSchema = z.object({
  original: AudioMixSettingsSchema.optional(),
  'system-audio': AudioMixSettingsSchema.optional(),
  microphone: AudioMixSettingsSchema.optional(),
  camera: AudioMixSettingsSchema.optional(),
  narration: AudioMixSettingsSchema.optional(),
  music: AudioMixSettingsSchema.optional(),
}).strict();
export type AudioMix = z.infer<typeof AudioMixSchema>;

export const SourceAnchorSchema = z.object({
  id: z.string().regex(/^anchor_[a-zA-Z0-9-]{8,80}$/),
  kind: z.enum(['caption', 'effect']),
  source_asset_id: AssetIdSchema,
  source_time_ms: z.number().int().nonnegative(),
  duration_ms: z.number().int().positive().optional(),
  payload_ref: z.string().min(1).max(200).optional(),
}).strict();
export type SourceAnchor = z.infer<typeof SourceAnchorSchema>;

export const SceneCompositionSchema = z.object({
  version: z.literal(1),
  clips: z.array(CompositionClipSchema).min(1).max(500),
  audio_mix: AudioMixSchema.default({}),
  anchors: z.array(SourceAnchorSchema).max(5_000).optional(),
}).strict().superRefine((composition, ctx) => {
  const ids = new Set<string>();
  let expectedStart = 0;
  for (const [index, clip] of composition.clips.entries()) {
    if (ids.has(clip.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['clips', index, 'id'], message: 'clip instance IDs must be unique' });
    }
    ids.add(clip.id);
    if (clip.timeline_start_ms !== expectedStart) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['clips', index, 'timeline_start_ms'], message: 'clip timeline starts must be contiguous and ordered' });
    }
    expectedStart += clip.source_out_ms - clip.source_in_ms;
  }
});
export type SceneComposition = z.infer<typeof SceneCompositionSchema>;

export function normalizeCompositionTimeline(clips: CompositionClip[]): CompositionClip[] {
  let timelineStartMs = 0;
  return clips.map((clip) => {
    const normalized = { ...clip, timeline_start_ms: timelineStartMs };
    timelineStartMs += clip.source_out_ms - clip.source_in_ms;
    return normalized;
  });
}

export function compositionDurationMs(composition: SceneComposition): number {
  const final = composition.clips.at(-1);
  return final ? final.timeline_start_ms + final.source_out_ms - final.source_in_ms : 0;
}

export function effectiveMixSettings(composition: SceneComposition, role: AudioMixRole): AudioMixSettings {
  return AudioMixSettingsSchema.parse(composition.audio_mix[role] ?? {});
}

/** Source anchors follow every instance that exposes their immutable source time. */
export function sourceAnchorsForClip(composition: SceneComposition, clip: CompositionClip): SourceAnchor[] {
  return (composition.anchors ?? []).filter((anchor) =>
    anchor.source_asset_id === clip.source_asset_id
    && anchor.source_time_ms >= clip.source_in_ms
    && anchor.source_time_ms < clip.source_out_ms,
  );
}
