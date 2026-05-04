import { z } from 'zod';

/** xAI metadata enums (mirror api.x.ai's accepted values). */
export const VoiceGenderSchema = z.enum(['male', 'female', 'neutral']);
export type VoiceGender = z.infer<typeof VoiceGenderSchema>;

export const VoiceAgeSchema = z.enum(['young', 'middle-aged', 'old']);
export type VoiceAge = z.infer<typeof VoiceAgeSchema>;

export const VoiceUseCaseSchema = z.enum([
  'conversational',
  'narration',
  'characters',
  'educational',
  'advertisement',
  'social_media',
  'entertainment',
]);
export type VoiceUseCase = z.infer<typeof VoiceUseCaseSchema>;

export const VoiceToneSchema = z.enum([
  'warm',
  'casual',
  'professional',
  'friendly',
  'authoritative',
  'expressive',
  'calm',
]);
export type VoiceTone = z.infer<typeof VoiceToneSchema>;

/** Per-provider registration record. */
export const VoiceProviderRegistrationSchema = z.object({
  /** Provider-side identifier (e.g. xAI's 8-char voice_id). */
  voice_id: z.string(),
  registeredAt: z.string().datetime(),
  /** True if user typed in a voice_id rather than uploading from us. */
  imported: z.boolean().optional(),
});
export type VoiceProviderRegistration = z.infer<typeof VoiceProviderRegistrationSchema>;

/** A voice clone the user has recorded or imported. */
export const VoiceCloneSchema = z.object({
  /** Slug, derived from name. Stable; used in URLs and filesystem path. */
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,79}$/, 'Slug: lowercase alphanumeric + hyphens, max 80 chars'),
  name: z.string().min(1).max(120),
  description: z.string().optional(),
  /** What the speaker said in audio.wav. Optional. */
  transcript: z.string().optional(),
  createdAt: z.string().datetime(),
  /** Whether `audio.wav` exists on disk. False for voices imported by voice_id only. */
  hasAudio: z.boolean(),
  /** Duration of audio.wav, seconds. */
  durationSec: z.number().optional(),
  // xAI-style metadata; harmless on Fish, sent on register.
  gender: VoiceGenderSchema.optional(),
  age: VoiceAgeSchema.optional(),
  accent: z.string().optional(),
  /** BCP-47 like 'en-US' or ISO 639 like 'en'. */
  language: z.string().optional(),
  use_case: VoiceUseCaseSchema.optional(),
  tone: VoiceToneSchema.optional(),
  providers: z.object({
    xai: VoiceProviderRegistrationSchema.optional(),
  }).default({}),
});
export type VoiceClone = z.infer<typeof VoiceCloneSchema>;

/** Mutable subset of metadata for PATCH. */
export const VoiceCloneUpdateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().nullable().optional(),
  transcript: z.string().nullable().optional(),
  gender: VoiceGenderSchema.nullable().optional(),
  age: VoiceAgeSchema.nullable().optional(),
  accent: z.string().nullable().optional(),
  language: z.string().nullable().optional(),
  use_case: VoiceUseCaseSchema.nullable().optional(),
  tone: VoiceToneSchema.nullable().optional(),
}).strict();
export type VoiceCloneUpdate = z.infer<typeof VoiceCloneUpdateSchema>;
