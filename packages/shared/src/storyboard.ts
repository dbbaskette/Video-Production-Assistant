import { z } from 'zod';

export const RecordingSchema = z.object({
  source: z.string(),
  duration_sec: z.number().positive().optional(),
  ingested_at: z.string().datetime().optional(),
});
export type Recording = z.infer<typeof RecordingSchema>;

export const TimingSchema = z.object({
  word: z.string(),
  t: z.number(),
});
export type Timing = z.infer<typeof TimingSchema>;

export const NarrationSchema = z.object({
  script: z.string(),
  audio: z.string().optional(),
  subtitles: z.object({
    srt: z.string().optional(),
    vtt: z.string().optional(),
  }).optional(),
  tts: z.object({
    engine: z.string().optional(),
    voice: z.string().optional(),
    speed: z.number().positive().optional(),
  }).optional(),
  timings: z.array(TimingSchema).optional(),
});
export type Narration = z.infer<typeof NarrationSchema>;

export const LowerThirdSchema = z.object({
  title: z.string(),
  subtitle: z.string().optional(),
  style: z.enum(['frosted', 'solid', 'minimal']).default('frosted'),
  in_sec: z.number().min(0),
  out_sec: z.number().min(0),
});
export type LowerThird = z.infer<typeof LowerThirdSchema>;

export const ReviewSchema = z.object({
  status: z.enum(['ok', 'warnings', 'issues']),
  notes: z.array(z.string()),
});
export type Review = z.infer<typeof ReviewSchema>;

export const SceneTypeSchema = z.enum(['desktop', 'terminal', 'browser', 'slide']);
export type SceneType = z.infer<typeof SceneTypeSchema>;

export const SceneSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  description: z.string(),
  type: SceneTypeSchema.default('desktop'),
  recording: RecordingSchema.optional(),
  narration: NarrationSchema.optional(),
  lower_thirds: z.array(LowerThirdSchema).optional(),
  overlay_render: z.string().optional(),
  review: ReviewSchema.optional(),
});
export type Scene = z.infer<typeof SceneSchema>;

export const StoryboardDefaultsSchema = z.object({
  brand: z.string().optional(),
  voice_profile: z.string().optional(),
  tts_engine: z.string().optional(),
});
export type StoryboardDefaults = z.infer<typeof StoryboardDefaultsSchema>;

export const StoryboardProjectSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  created: z.string().datetime(),
  objective: z.string().optional(),
  audience: z.string().optional(),
  source_docs: z.array(z.string()).optional(),
});

export const StoryboardSchema = z.object({
  schema_version: z.literal(1),
  project: StoryboardProjectSchema,
  defaults: StoryboardDefaultsSchema.optional(),
  scenes: z.array(SceneSchema),
});
export type Storyboard = z.infer<typeof StoryboardSchema>;
