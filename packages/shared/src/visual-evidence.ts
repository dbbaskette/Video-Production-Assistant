import { z } from 'zod';
import { AssetIdSchema } from './asset.js';
import { ClipInstanceIdSchema, type SceneComposition } from './composition.js';

export const NormalizedRectSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().positive().max(1),
  height: z.number().positive().max(1),
}).strict().superRefine((rect, ctx) => {
  if (rect.x + rect.width > 1 || rect.y + rect.height > 1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'normalized rectangle must stay inside the source frame' });
  }
});
export type NormalizedRect = z.infer<typeof NormalizedRectSchema>;

const EffectBase = {
  id: z.string().regex(/^effect_[A-Za-z0-9-]{8,80}$/),
  clip_instance_id: ClipInstanceIdSchema,
  source_asset_id: AssetIdSchema,
  source_in_ms: z.number().int().nonnegative(),
  source_out_ms: z.number().int().positive(),
  rect: NormalizedRectSchema,
};
const timed = <T extends z.ZodRawShape>(shape: T) => z.object({ ...EffectBase, ...shape }).strict();

export const VisualEffectSchema = z.discriminatedUnion('type', [
  timed({ type: z.literal('redaction'), opacity: z.literal(1).default(1) }),
  timed({ type: z.literal('highlight'), color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default('#FACC15'), opacity: z.number().min(0.1).max(0.8).default(0.3) }),
  timed({ type: z.literal('zoom'), scale: z.number().min(1.1).max(3), transition_ms: z.number().int().min(0).max(2_000).default(250) }),
  timed({ type: z.literal('text'), text: z.string().trim().min(1).max(500), color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default('#FFFFFF') }),
  timed({ type: z.literal('arrow'), color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default('#F97316'), direction: z.enum(['left', 'right', 'up', 'down']).default('right') }),
  timed({ type: z.literal('background'), color: z.string().regex(/^#[0-9A-Fa-f]{6}$/) }),
  timed({ type: z.literal('camera'), corner_radius: z.number().int().min(0).max(100).default(16) }),
  timed({ type: z.literal('logo'), asset_id: AssetIdSchema, opacity: z.number().min(0.1).max(1).default(1) }),
  timed({ type: z.enum(['title', 'lower-third']), text: z.string().trim().min(1).max(500), preset: z.enum(['fade', 'slide-up']).default('fade') }),
]).superRefine((effect, ctx) => {
  if (effect.source_out_ms <= effect.source_in_ms) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['source_out_ms'], message: 'effect out must be after in' });
});
export type VisualEffect = z.infer<typeof VisualEffectSchema>;

export const TranscriptWordSchema = z.object({
  id: z.string().regex(/^word_[A-Za-z0-9-]{6,80}$/),
  text: z.string().trim().min(1).max(120),
  original_text: z.string().trim().min(1).max(120).optional(),
  start_ms: z.number().int().nonnegative(),
  end_ms: z.number().int().positive(),
  confidence: z.number().min(0).max(1).optional(),
  speaker: z.string().trim().min(1).max(80).optional(),
}).strict().superRefine((word, ctx) => {
  if (word.end_ms <= word.start_ms) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['end_ms'], message: 'word end must be after start' });
});
export type TranscriptWord = z.infer<typeof TranscriptWordSchema>;

export const TranscriptPassageSchema = z.object({
  id: z.string().regex(/^passage_[A-Za-z0-9-]{6,80}$/),
  start_ms: z.number().int().nonnegative(),
  end_ms: z.number().int().positive(),
  text: z.string().min(1).max(4_000),
  word_ids: z.array(z.string()).min(1).max(200),
}).strict();

export const SourceTranscriptSchema = z.object({
  version: z.literal(1),
  source_asset_id: AssetIdSchema,
  source_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  language: z.literal('en'),
  provider: z.literal('gemini'),
  model: z.string().min(1).max(500),
  settings_hash: z.string().regex(/^[a-f0-9]{64}$/),
  created_at: z.string().datetime(),
  coverage: z.array(z.object({ start_ms: z.number().int().nonnegative(), end_ms: z.number().int().positive() }).strict()).min(1),
  words: z.array(TranscriptWordSchema).max(100_000),
  passages: z.array(TranscriptPassageSchema).max(5_000),
  subtitles: z.object({ srt: z.string().min(1), vtt: z.string().min(1).optional() }).strict().optional(),
}).strict();
export type SourceTranscript = z.infer<typeof SourceTranscriptSchema>;

export const EvidenceItemSchema = z.object({
  id: z.string().regex(/^evidence_[A-Za-z0-9-]{6,80}$/),
  kind: z.enum(['frame', 'contact-sheet', 'excerpt']),
  source_asset_id: AssetIdSchema,
  source_start_ms: z.number().int().nonnegative(),
  source_end_ms: z.number().int().nonnegative(),
  path: z.string().min(1).max(500),
  source_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  settings_hash: z.string().regex(/^[a-f0-9]{64}$/),
  created_at: z.string().datetime(),
}).strict();
export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;

export interface MappedTranscriptWord extends TranscriptWord {
  mapped_id: string;
  clip_instance_id: string;
  timeline_start_ms: number;
  timeline_end_ms: number;
}

export function mapTranscriptToComposition(transcript: SourceTranscript, composition: SceneComposition): MappedTranscriptWord[] {
  const mapped: MappedTranscriptWord[] = [];
  for (const clip of composition.clips) {
    if (clip.source_asset_id !== transcript.source_asset_id) continue;
    for (const word of transcript.words) {
      if (word.end_ms <= clip.source_in_ms || word.start_ms >= clip.source_out_ms) continue;
      const start = Math.max(word.start_ms, clip.source_in_ms);
      const end = Math.min(word.end_ms, clip.source_out_ms);
      mapped.push({
        ...word,
        mapped_id: `${clip.id}:${word.id}`,
        clip_instance_id: clip.id,
        timeline_start_ms: clip.timeline_start_ms + start - clip.source_in_ms,
        timeline_end_ms: clip.timeline_start_ms + end - clip.source_in_ms,
      });
    }
  }
  return mapped.sort((left, right) => left.timeline_start_ms - right.timeline_start_ms || left.mapped_id.localeCompare(right.mapped_id));
}

function srtTime(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1_000);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(ms % 1_000).padStart(3, '0')}`;
}

export function mappedTranscriptSrt(words: MappedTranscriptWord[], maxWords = 8): string {
  const cues: string[] = [];
  for (let index = 0; index < words.length; index += maxWords) {
    const group = words.slice(index, index + maxWords);
    if (group.length === 0) continue;
    cues.push(`${cues.length + 1}\n${srtTime(group[0]!.timeline_start_ms)} --> ${srtTime(group.at(-1)!.timeline_end_ms)}\n${group.map((word) => word.text).join(' ')}`);
  }
  return cues.length ? `${cues.join('\n\n')}\n` : '';
}
