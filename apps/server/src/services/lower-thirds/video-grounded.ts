/**
 * Video-grounded lower-thirds recommendation.
 *
 * Mirrors services/video-narration/index.ts: uploads the recording to
 * Gemini's Files API, then asks the model to recommend lower-thirds
 * grounded in what's actually on screen (so the in_sec / out_sec
 * timestamps line up with real visual moments instead of being guessed
 * from the duration).
 *
 * Inputs flow in the same order-of-authority used by the narration
 * pipeline:
 *   1. Scene intent — the user's "what is this scene demonstrating?"
 *      (north star). Drives WHICH moments to highlight.
 *   2. Project objective + audience — depth + tone.
 *   3. Source-docs — factual reference: terminology, product names,
 *      claims, numbers (e.g. "Greenplum MCP server" not "the system").
 *   4. The video itself — visual + pacing anchor. Identifies on-screen
 *      transitions so the timestamps land on real moments.
 *   5. Auto-generated description — supporting only.
 *
 * Falls back to the text-only `recommendLowerThirds` is the route's
 * job — this function always uses the video.
 */

import type { LlmClient } from '../llm/index.js';
import { loadPrompt } from '../llm/prompts.js';
import { withReferenceContext } from '../project-source-docs/inject.js';
import {
  uploadVideo,
  waitForFileActive,
  generateWithVideo,
  deleteFile,
} from '../video-narration/gemini-files.js';
import type { LowerThird } from '@vpa/shared';

export type VideoLtPhase = 'uploading' | 'processing' | 'generating' | 'done';

export interface VideoLtInput {
  /** Absolute path to the scene's recording on disk. */
  videoPath: string;
  videoMimeType?: string;
  sceneName: string;
  sceneDescription: string;
  /** User-authored "what is this scene demonstrating?" — the north star. */
  sceneIntent?: string;
  durationSec?: number;
  projectObjective?: string;
  projectAudience?: string;
  /** When provided, source-docs are prepended to the prompt. */
  projectPath?: string;
}

export interface GeminiVideoConfig {
  apiKey: string;
  model: string;
}

export async function recommendLowerThirdsWithVideo(
  input: VideoLtInput,
  gemini: GeminiVideoConfig,
  workspaceRoot: string,
  llm: LlmClient,
  onPhase?: (phase: VideoLtPhase, detail?: string) => void,
): Promise<LowerThird[]> {
  const systemPrompt = await loadPrompt(workspaceRoot, 'lower-third-recommender-video');

  // User prompt — same shape as the video-grounded narration prompt.
  // Lead with intent (the north star), then objective/audience, then
  // metadata, then the explicit "watch the video" instruction.
  const lines: string[] = [];
  if (input.sceneIntent) {
    lines.push(`What this scene is demonstrating (north star): ${input.sceneIntent}`);
  }
  if (input.projectObjective) lines.push(`Project objective: ${input.projectObjective}`);
  if (input.projectAudience) lines.push(`Target audience: ${input.projectAudience}`);
  lines.push(`Scene name: ${input.sceneName}`);
  lines.push(`Auto-generated description (supporting context): ${input.sceneDescription}`);
  if (input.durationSec !== undefined) {
    lines.push(`Duration: ${input.durationSec.toFixed(1)} seconds`);
  }
  lines.push('');
  lines.push(
    'Watch the video and identify the visual transitions worth labelling. ' +
      'Anchor each lower-third to a real on-screen moment (a screen change, ' +
      'a new command, a new card appearing, etc.) — not arbitrary intervals.',
  );

  const userPrompt = await withReferenceContext(lines.join('\n'), {
    projectPath: input.projectPath,
    summarize: true,
    llm,
  });
  const mime = input.videoMimeType ?? 'video/mp4';

  onPhase?.('uploading');
  const uploaded = await uploadVideo(
    gemini.apiKey,
    input.videoPath,
    mime,
    `${input.sceneName} recording (LT recommend)`,
  );

  try {
    onPhase?.('processing');
    const ready = await waitForFileActive(gemini.apiKey, uploaded.name, {
      onPoll: (state) => {
        if (state !== 'ACTIVE') onPhase?.('processing', state);
      },
    });

    onPhase?.('generating');
    const text = await generateWithVideo({
      apiKey: gemini.apiKey,
      model: gemini.model,
      systemPrompt,
      userPrompt,
      videoFileUri: ready.uri,
      videoMimeType: mime,
      temperature: 0.7,
      responseMimeType: 'application/json',
    });

    onPhase?.('done');

    // Tolerate both raw arrays and ```json fenced responses, same as the
    // text-only recommendLowerThirds.
    const trimmed = text.trim();
    const jsonStr = trimmed.startsWith('[')
      ? trimmed
      : trimmed.replace(/^```json\s*/, '').replace(/```\s*$/, '');
    const parsed = JSON.parse(jsonStr) as Array<{
      title: string;
      subtitle?: string;
      style?: string;
      in_sec: number;
      out_sec: number;
    }>;

    return parsed.map((lt) => ({
      title: lt.title,
      subtitle: lt.subtitle,
      style: (lt.style as 'frosted' | 'solid' | 'minimal') ?? 'frosted',
      in_sec: lt.in_sec,
      out_sec: lt.out_sec,
    }));
  } finally {
    void deleteFile(gemini.apiKey, uploaded.name);
  }
}
