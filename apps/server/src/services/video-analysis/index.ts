import { VideoUnderstandingBriefSchema, type Scene, type VideoUnderstandingBrief } from '@vpa/shared';
import type { LlmClient } from '../llm/index.js';
import { loadPrompt } from '../llm/index.js';
import { withReferenceContext } from '../project-source-docs/inject.js';

export interface SceneAnalysis {
  name: string;
  description: string;
  type: 'desktop' | 'terminal' | 'browser' | 'slide';
}

export interface AnalysisInput {
  filename: string;
  duration_sec: number;
  width: number;
  height: number;
  sceneIndex: number;
  totalScenes: number;
  projectObjective?: string;
  /** Pulled from project.yaml — same field the script generator uses. */
  projectAudience?: string;
  /** When provided, the project's source-docs are prepended to the prompt. */
  projectPath?: string;
}

async function buildUserPrompt(input: AnalysisInput, llm: LlmClient): Promise<string> {
  const lines = [
    `Scene ${input.sceneIndex + 1} of ${input.totalScenes}`,
    `Filename: ${input.filename}`,
    `Duration: ${input.duration_sec.toFixed(1)} seconds`,
    `Resolution: ${input.width}x${input.height}`,
  ];
  if (input.projectObjective) lines.push(`Project objective: ${input.projectObjective}`);
  if (input.projectAudience) lines.push(`Target audience: ${input.projectAudience}`);

  return withReferenceContext(lines.join('\n'), {
    projectPath: input.projectPath,
    summarize: true,
    llm,
  });
}

function parseAnalysis(text: string, sceneIndex: number): SceneAnalysis {
  const parsed = JSON.parse(text);
  return {
    name: parsed.name ?? `Scene ${sceneIndex + 1}`,
    description: parsed.description ?? 'Recording uploaded',
    type: parsed.type ?? 'desktop',
  };
}

/**
 * Text-only scene analysis. The original behaviour: scene metadata +
 * source-docs are sent; the model never sees the actual video.
 */
export async function analyzeRecording(
  input: AnalysisInput,
  llm: LlmClient,
  workspaceRoot: string,
): Promise<SceneAnalysis> {
  const systemPrompt = await loadPrompt(workspaceRoot, 'scene-description');
  const userPrompt = await buildUserPrompt(input, llm);

  const result = await llm.complete({
    systemPrompt,
    userPrompt,
    responseFormat: 'json',
    temperature: 0.7,
  });

  return parseAnalysis(result.text, input.sceneIndex);
}

const SCENE_NAME_MAX_LENGTH = 120;
const SCENE_DESCRIPTION_MAX_LENGTH = 2_000;

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return value.slice(0, maxLength - 1).trimEnd() + '…';
}

function nameFromBrief(scene: Scene, brief: VideoUnderstandingBrief): string {
  const summary = normalizeText(brief.visual_summary);
  const firstThought = summary.split(/(?<=[.!?])\s/u, 1)[0]?.replace(/[.!?]+$/u, '') ?? '';
  const words = firstThought.split(' ').filter(Boolean).slice(0, 6).join(' ');
  return truncate(words || normalizeText(scene.name), SCENE_NAME_MAX_LENGTH);
}

function typeFromBrief(brief: VideoUnderstandingBrief): SceneAnalysis['type'] {
  const evidence = normalizeText([
    brief.visual_summary,
    ...brief.segments.flatMap((segment) => [
      segment.screen_change,
      ...segment.visible_labels,
      ...segment.on_screen_terms,
    ]),
  ].join(' ')).toLowerCase();

  if (/\b(terminal|command[ -]line|shell|console|cli|repl)\b/u.test(evidence)) return 'terminal';
  if (/\b(slide|slides|presentation|keynote|powerpoint|deck)\b/u.test(evidence)) return 'slide';
  if (/\b(browser|web ?page|website|url|web app)\b/u.test(evidence)) return 'browser';
  return 'desktop';
}

/**
 * Produce bounded scene metadata from a validated, reusable video brief.
 * This is deliberately pure: grounded reanalysis never makes a second model
 * request and therefore cannot silently fall back to metadata-only analysis.
 */
export function proposeSceneMetadataFromBrief(
  scene: Scene,
  input: VideoUnderstandingBrief,
): SceneAnalysis {
  const brief = VideoUnderstandingBriefSchema.parse(input);
  return {
    name: nameFromBrief(scene, brief),
    description: truncate(normalizeText(brief.visual_summary), SCENE_DESCRIPTION_MAX_LENGTH),
    type: typeFromBrief(brief),
  };
}
