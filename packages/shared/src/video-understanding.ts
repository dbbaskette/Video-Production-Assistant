import { z } from 'zod';

export const VIDEO_BRIEF_SCHEMA_VERSION = 1;
export const VIDEO_BRIEF_PROMPT_VERSION = 1;

const BoundedTextSchema = z.string().min(1).max(200);

export const VideoUnderstandingSegmentSchema = z.object({
  id: z.string().min(1).max(120),
  start_sec: z.number().finite().nonnegative(),
  end_sec: z.number().finite().nonnegative(),
  screen_change: z.string().min(1).max(2000),
  visible_labels: z.array(BoundedTextSchema).max(50),
  on_screen_terms: z.array(BoundedTextSchema).max(50),
}).strict();
export type VideoUnderstandingSegment = z.infer<typeof VideoUnderstandingSegmentSchema>;

export const VideoPacingCueSchema = z.object({
  segment_id: z.string().min(1).max(120),
  cue: z.string().min(1).max(1000),
}).strict();
export type VideoPacingCue = z.infer<typeof VideoPacingCueSchema>;

export const VideoNarrationCueSchema = z.object({
  segment_id: z.string().min(1).max(120),
  cue: z.string().min(1).max(1000),
}).strict();
export type VideoNarrationCue = z.infer<typeof VideoNarrationCueSchema>;

export const VideoLowerThirdCandidateSchema = z.object({
  segment_id: z.string().min(1).max(120),
  reason: z.string().min(1).max(1000),
}).strict();
export type VideoLowerThirdCandidate = z.infer<typeof VideoLowerThirdCandidateSchema>;

const VideoUnderstandingBriefBaseSchema = z.object({
  schema_version: z.literal(VIDEO_BRIEF_SCHEMA_VERSION),
  prompt_version: z.literal(VIDEO_BRIEF_PROMPT_VERSION),
  scene_id: z.string().min(1).max(120),
  source: z.object({
    path: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    duration_sec: z.number().finite().positive(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }).strict(),
  model: z.object({
    entry_id: z.string().min(1).max(200),
    provider: z.literal('gemini'),
    model: z.string().min(1).max(500),
  }).strict(),
  created_at: z.string().datetime(),
  visual_summary: z.string().min(1).max(4000),
  segments: z.array(VideoUnderstandingSegmentSchema).min(1).max(200),
  pacing_cues: z.array(VideoPacingCueSchema).max(100),
  narration_cues: z.array(VideoNarrationCueSchema).max(100),
  lower_third_candidates: z.array(VideoLowerThirdCandidateSchema).max(50),
}).strict();

export const VideoUnderstandingBriefSchema = VideoUnderstandingBriefBaseSchema.superRefine((brief, ctx) => {
  const segmentIds = new Set<string>();
  let previousEnd = 0;

  brief.segments.forEach((segment, index) => {
    if (segment.end_sec <= segment.start_sec) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['segments', index, 'end_sec'],
        message: 'Segment end_sec must be greater than start_sec.',
      });
    }
    if (segment.start_sec < previousEnd) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['segments', index, 'start_sec'],
        message: 'Segments must be monotonic and non-overlapping.',
      });
    }
    if (segment.end_sec > brief.source.duration_sec) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['segments', index, 'end_sec'],
        message: 'Segment end_sec must not exceed source duration_sec.',
      });
    }
    if (segmentIds.has(segment.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['segments', index, 'id'],
        message: 'Segment IDs must be unique.',
      });
    }
    segmentIds.add(segment.id);
    previousEnd = segment.end_sec;
  });

  const linkedCues = [
    ['pacing_cues', brief.pacing_cues],
    ['narration_cues', brief.narration_cues],
    ['lower_third_candidates', brief.lower_third_candidates],
  ] as const;
  for (const [field, cues] of linkedCues) {
    cues.forEach((cue, index) => {
      if (!segmentIds.has(cue.segment_id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field, index, 'segment_id'],
          message: 'Segment-linked cues must reference an existing segment ID.',
        });
      }
    });
  }
});
export type VideoUnderstandingBrief = z.infer<typeof VideoUnderstandingBriefSchema>;
