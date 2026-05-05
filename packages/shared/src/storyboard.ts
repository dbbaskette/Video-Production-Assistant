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

export const NarrationChunkSchema = z.object({
  index: z.number(),
  text: z.string(),
  audio: z.string().optional(),        // e.g. "narration/scene-01-chunk-00.mp3"
  durationSec: z.number().optional(),
  timings: z.array(TimingSchema).optional(),
  speaker: z.string().optional(),      // "A" | "B" — dialog mode speaker assignment
  /** Last failed-generation record. Cleared on next successful regeneration. */
  failed: z.object({
    reason: z.string(),
    at: z.string(),
  }).optional(),
});
export type NarrationChunk = z.infer<typeof NarrationChunkSchema>;

/** Per-speaker voice configuration (used in dialog mode). */
export const SpeakerConfigSchema = z.object({
  engine: z.string(),
  voice: z.string(),
  speed: z.number().positive().default(1.0),
  label: z.string().optional(),        // e.g. "Narrator", "Host", "Guest"
});
export type SpeakerConfig = z.infer<typeof SpeakerConfigSchema>;

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
  chunks: z.array(NarrationChunkSchema).optional(),
  mode: z.enum(['monologue', 'dialog']).optional(),   // default: 'monologue'
  speakers: z.record(z.string(), SpeakerConfigSchema).optional(), // keyed by "A", "B"
  monologueScript: z.string().optional(),  // monologue version (preserved across mode switches)
  dialogScript: z.string().optional(),     // dialog version (preserved across mode switches)
  dialogDirty: z.boolean().optional(),     // true = monologue changed since last dialog conversion
  // Per-mode chunk persistence — each mode keeps its own audio chunks because
  // the underlying text differs. `chunks` is the active set for the current mode;
  // these snapshots let us restore audio when toggling modes back and forth.
  monologueChunks: z.array(NarrationChunkSchema).optional(),
  dialogChunks: z.array(NarrationChunkSchema).optional(),
  // Restore-previous backup for the current monologue/dialog scripts.
  previousMonologueScript: z.string().nullable().optional(),
  previousDialogScript: z.string().nullable().optional(),
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
  /**
   * User-authored: what this scene is meant to demonstrate, in their own
   * words. Acts as the north star for narration generation — distinct
   * from `description` (which is auto-generated from the recording and
   * may be re-written by Re-analyze). Optional and never auto-populated;
   * if blank, narration falls back to using description + objective +
   * source-docs as before.
   */
  intent: z.string().optional(),
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
