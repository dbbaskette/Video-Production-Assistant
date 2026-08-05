import type { VideoUnderstandingBrief } from '@vpa/shared';
import type { LlmClient } from '../llm/index.js';
import { loadPrompt } from '../llm/index.js';
import { REFERENCE_BUDGET_CHARS } from '../project-source-docs/context.js';

export interface VideoGroundedScriptInput {
  sceneName: string;
  sceneDescription: string;
  sceneIntent?: string;
  durationSec: number;
  projectObjective?: string;
  projectAudience?: string;
  sourceContext?: string;
  brief: VideoUnderstandingBrief;
}

const GEMINI_FILE_URI = /https?:\/\/generativelanguage\.googleapis\.com\/[^\s)\]}]+/gi;

function redactTransportDetails(value: string, sourcePath: string): string {
  return value
    .split(sourcePath).join('[redacted video path]')
    .replace(GEMINI_FILE_URI, '[redacted Gemini file URI]');
}

function safeBriefText(value: string, sourcePath: string): string {
  return redactTransportDetails(value, sourcePath)
    .replace(/\s+/g, ' ')
    .trim();
}

function time(value: number): string {
  return value.toFixed(3);
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 1) return value.slice(0, Math.max(0, max));
  return `${value.slice(0, max - 1)}…`;
}

function boundedSection(title: string, lines: string[], allowance: number): string {
  if (allowance <= title.length + 1 || lines.length === 0) return '';
  const available = allowance - title.length - 1;
  const perLine = Math.max(1, Math.floor((available - Math.max(0, lines.length - 1)) / lines.length));
  const body = lines.map((line) => truncate(line, perLine)).join('\n');
  return truncate(`${title}\n${body}`, allowance);
}

/**
 * Serialize the validated brief without its source path, hash, model metadata,
 * provider response envelope, or any other transport detail. The compact
 * segment index is mandatory so truncation never drops ordering anchors.
 */
export function serializeVideoUnderstandingBrief(
  brief: VideoUnderstandingBrief,
  budget = REFERENCE_BUDGET_CHARS,
): string {
  const clean = (value: string) => safeBriefText(value, brief.source.path);
  const segmentIndex = brief.segments.map((segment) => (
    `${clean(segment.id)}@${time(segment.start_sec)}-${time(segment.end_sec)}`
  ));
  const required = `Ordered segment index (id@start-end seconds):\n${segmentIndex.join('\n')}`;
  if (required.length > budget) {
    throw new Error('The video brief segment index exceeds the prompt budget.');
  }

  let remaining = budget - required.length - 2;
  const visualAllowance = Math.min(4_050, Math.floor(remaining * 0.2));
  const visual = boundedSection('Visual summary:', [clean(brief.visual_summary)], visualAllowance);
  remaining -= visual.length > 0 ? visual.length + 2 : 0;

  const segmentLines = brief.segments.map((segment, index) => {
    const labels = segment.visible_labels.map(clean).filter(Boolean).join(', ');
    const terms = segment.on_screen_terms.map(clean).filter(Boolean).join(', ');
    return [
      `#${index + 1}`,
      `change=${clean(segment.screen_change)}`,
      labels ? `labels=${labels}` : '',
      terms ? `terms=${terms}` : '',
    ].filter(Boolean).join('; ');
  });
  const segmentAllowance = Math.floor(remaining * 0.6);
  const details = boundedSection('Ordered segment details:', segmentLines, segmentAllowance);
  remaining -= details.length > 0 ? details.length + 2 : 0;

  const pacingLines = brief.pacing_cues.map((cue) => (
    `${clean(cue.segment_id)}: ${clean(cue.cue)}`
  ));
  const pacingAllowance = Math.floor(remaining / 2);
  const pacing = boundedSection('Pacing cues:', pacingLines, pacingAllowance);
  remaining -= pacing.length > 0 ? pacing.length + 2 : 0;

  const narrationLines = brief.narration_cues.map((cue) => (
    `${clean(cue.segment_id)}: ${clean(cue.cue)}`
  ));
  const narration = boundedSection('Narration cues:', narrationLines, remaining);

  return [required, visual, details, pacing, narration].filter(Boolean).join('\n\n');
}

export async function generateScriptFromVideoBrief(
  input: VideoGroundedScriptInput,
  writer: LlmClient,
  workspaceRoot: string,
): Promise<string> {
  const baseSystemPrompt = await loadPrompt(workspaceRoot, 'narration-writer-video');
  const systemPrompt = [
    baseSystemPrompt,
    '',
    'You receive a validated, text-only video brief rather than video or provider transport data.',
    'Treat the brief as visual truth and the reference materials as factual truth.',
  ].join('\n');
  const targetWords = Math.round((input.durationSec / 60) * 150);
  const lines: string[] = [];
  if (input.sourceContext) {
    lines.push(input.sourceContext, '', '---', '');
  }
  if (input.sceneIntent) {
    lines.push(`What this scene is demonstrating (north star): ${input.sceneIntent}`);
  }
  if (input.projectObjective) lines.push(`Project objective: ${input.projectObjective}`);
  if (input.projectAudience) lines.push(`Target audience: ${input.projectAudience}`);
  lines.push(`Scene name: ${input.sceneName}`);
  lines.push(`Auto-generated description (supporting context): ${input.sceneDescription}`);
  lines.push(`Duration: ${input.durationSec.toFixed(1)} seconds`);
  lines.push(`Target word count: ~${targetWords} words`);
  lines.push('');
  lines.push('Use the following brief as visual truth. Use reference materials above as factual truth.');
  lines.push('Do not infer access to the original video, local files, or provider metadata.');
  lines.push('');
  lines.push(serializeVideoUnderstandingBrief(input.brief));

  const userPrompt = redactTransportDetails(lines.join('\n'), input.brief.source.path);
  const result = await writer.complete({
    systemPrompt,
    userPrompt,
    temperature: 0.8,
  });
  const script = result.text.trim();
  if (!script) throw new Error('The writing model returned an empty script.');
  return script;
}
