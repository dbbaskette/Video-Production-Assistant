import { z } from 'zod';
import {
  VideoUnderstandingBriefSchema,
  type LowerThird,
  type VideoUnderstandingBrief,
} from '@vpa/shared';
import type { LlmClient } from '../llm/index.js';
import { loadPrompt } from '../llm/prompts.js';
import { withReferenceContext } from '../project-source-docs/inject.js';
import { serializeVideoUnderstandingBrief } from '../script/video-grounded.js';

export interface VideoLtInput {
  /** Absolute source path used only for brief redaction checks; never sent to the writer. */
  videoPath: string;
  videoMimeType?: string;
  sceneName: string;
  sceneDescription: string;
  sceneIntent?: string;
  durationSec?: number;
  projectObjective?: string;
  projectAudience?: string;
  /** Used to load source-document text. The path itself is never sent to the writer. */
  projectPath?: string;
}

const WriterLowerThirdSchema = z.object({
  segment_id: z.string().min(1).max(120),
  title: z.string().trim().min(1).max(40),
  subtitle: z.string().trim().min(1).max(60).optional(),
  style: z.enum(['frosted', 'solid', 'minimal']),
}).strict();

const WriterLowerThirdSetSchema = z.array(WriterLowerThirdSchema).min(1).max(5);
const MAX_LOWER_THIRD_DURATION_SEC = 6;
const GEMINI_FILE_URI = /https?:\/\/generativelanguage\.googleapis\.com\/[^\s)\]}]+/gi;
const LOCAL_FILE_URI = /file:\/\/[^\s)\]}]+/gi;

function redactTransportDetails(value: string, paths: string[]): string {
  let redacted = value;
  for (const path of paths) {
    if (path) redacted = redacted.split(path).join('[redacted video path]');
  }
  return redacted
    .replace(GEMINI_FILE_URI, '[redacted Gemini file URI]')
    .replace(LOCAL_FILE_URI, '[redacted file URI]');
}

function parseWriterResponse(text: string) {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('The writing model returned invalid lower-third JSON.');
  }
  const parsed = WriterLowerThirdSetSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error('The writing model returned invalid lower-third JSON.');
  }
  return parsed.data;
}

function validateSegmentSelections(
  selections: z.infer<typeof WriterLowerThirdSetSchema>,
  brief: VideoUnderstandingBrief,
): void {
  const indexById = new Map(brief.segments.map((segment, index) => [segment.id, index]));
  const selected = new Set<string>();
  let previousIndex = -1;

  for (const selection of selections) {
    const index = indexById.get(selection.segment_id);
    if (index === undefined) {
      throw new Error('The writing model selected an unknown segment.');
    }
    if (selected.has(selection.segment_id)) {
      throw new Error('The writing model selected a duplicate segment.');
    }
    if (index <= previousIndex) {
      throw new Error('The writing model selections do not follow brief order.');
    }
    selected.add(selection.segment_id);
    previousIndex = index;
  }
}

function userPrompt(
  input: VideoLtInput,
  brief: VideoUnderstandingBrief,
): string {
  const lines: string[] = [];
  if (input.sceneIntent) {
    lines.push(`What this scene is demonstrating (north star): ${input.sceneIntent}`);
  }
  if (input.projectObjective) lines.push(`Project objective: ${input.projectObjective}`);
  if (input.projectAudience) lines.push(`Target audience: ${input.projectAudience}`);
  lines.push(`Scene name: ${input.sceneName}`);
  lines.push(`Auto-generated description (supporting context): ${input.sceneDescription}`);
  lines.push('');
  lines.push('Use this validated video brief as visual and ordering truth:');
  lines.push(serializeVideoUnderstandingBrief(brief));
  if (brief.lower_third_candidates.length > 0) {
    lines.push('');
    lines.push('Candidate moments from the video analysis:');
    for (const candidate of brief.lower_third_candidates) {
      lines.push(`${candidate.segment_id}: ${candidate.reason}`);
    }
  }
  lines.push('');
  lines.push('Return only segment IDs plus title, optional subtitle, and style.');
  lines.push('Do not return in_sec, out_sec, timestamps, file paths, or provider data.');
  return lines.join('\n');
}

/**
 * Ask the resolved writing model for copy against a validated text-only video
 * brief. Segment IDs are the only timing anchors the writer can choose. VPA
 * owns the final times and derives them from the brief after the complete
 * response has passed strict validation.
 */
export async function recommendLowerThirdsFromBrief(
  input: VideoLtInput & { brief: VideoUnderstandingBrief },
  writer: LlmClient,
  workspaceRoot: string,
): Promise<LowerThird[]> {
  const brief = VideoUnderstandingBriefSchema.parse(input.brief);
  const systemPrompt = await loadPrompt(workspaceRoot, 'lower-third-recommender-video');
  const prompt = await withReferenceContext(userPrompt(input, brief), {
    projectPath: input.projectPath,
    summarize: true,
    llm: writer,
  });
  const result = await writer.complete({
    systemPrompt,
    userPrompt: redactTransportDetails(prompt, [input.videoPath, brief.source.path]),
    responseFormat: 'json',
    temperature: 0.7,
  });
  const selections = parseWriterResponse(result.text);
  validateSegmentSelections(selections, brief);

  const segmentById = new Map(brief.segments.map((segment) => [segment.id, segment]));
  const sourceDuration = brief.source.duration_sec;
  return selections.map((selection) => {
    const segment = segmentById.get(selection.segment_id)!;
    const inSec = Math.max(0, Math.min(segment.start_sec, sourceDuration));
    const outSec = Math.max(inSec, Math.min(
      segment.end_sec,
      sourceDuration,
      inSec + MAX_LOWER_THIRD_DURATION_SEC,
    ));
    if (outSec <= inSec) {
      throw new Error('The selected brief segment has no usable duration.');
    }
    return {
      title: selection.title,
      ...(selection.subtitle ? { subtitle: selection.subtitle } : {}),
      style: selection.style,
      in_sec: inSec,
      out_sec: outSec,
    };
  });
}
