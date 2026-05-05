/**
 * Video-grounded script generation. Uploads the scene's recording to
 * Gemini's Files API, then asks the model to write a narration script
 * grounded in what's actually on screen rather than just the metadata.
 *
 * Hybrid mode: the existing scene metadata (name, description, duration,
 * objective, audience, source-docs) is still passed in as supporting
 * context, but the video is the source of truth — the prompt explicitly
 * tells the model to trust the video over the description.
 *
 * Currently Gemini-only because Gemini is the multimodal provider we have
 * configured + it accepts video natively via the Files API. The script
 * route falls back to the text-only path for non-Gemini providers.
 */

import type { LlmClient } from '../llm/index.js';
import { loadPrompt } from '../llm/index.js';
import { withReferenceContext } from '../project-source-docs/inject.js';
import {
  uploadVideo,
  waitForFileActive,
  generateWithVideo,
  deleteFile,
  type GeminiFile,
} from './gemini-files.js';

export type VideoScriptPhase =
  | 'uploading'
  | 'processing'   // Gemini's PROCESSING state (server-side analysis)
  | 'generating'   // generateContent call
  | 'done';

export interface VideoScriptInput {
  /** Absolute path to the scene's recording on disk. */
  videoPath: string;
  /** Default 'video/mp4'. */
  videoMimeType?: string;
  sceneName: string;
  sceneDescription: string;
  /**
   * User-authored north star — what this scene is trying to teach. The
   * prompt frames the video as the visual/pacing anchor *for this intent*
   * and the source-docs as the factual reference. Without an intent we
   * fall back to the older description-led behaviour.
   */
  sceneIntent?: string;
  durationSec: number;
  projectObjective?: string;
  projectAudience?: string;
  /** When provided, the project's source-docs are prepended to the user prompt. */
  projectPath?: string;
}

export interface GeminiVideoConfig {
  apiKey: string;
  model: string;
}

/**
 * Generate a narration script grounded in the actual video content.
 *
 * The `llm` argument is only used for the source-docs summarization step
 * (when the bundle exceeds the budget). The actual generation happens via
 * Gemini's Files API + generateContent — bypassing the LlmClient
 * abstraction because that interface is intentionally text-only.
 */
export async function generateVideoGroundedScript(
  input: VideoScriptInput,
  gemini: GeminiVideoConfig,
  workspaceRoot: string,
  llm: LlmClient,
  onPhase?: (phase: VideoScriptPhase, detail?: string) => void,
): Promise<string> {
  const systemPrompt = await loadPrompt(workspaceRoot, 'narration-writer-video');

  const targetWords = Math.round((input.durationSec / 60) * 150);
  // Lead with the user's intent (the lens), then project context, then
  // auto-generated description (supporting only). The prompt template is
  // explicit about how to weight these vs. the video.
  const lines: string[] = [];
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
  lines.push('Watch the video to see the visual/pacing anchor for the intent above, then write the narration.');

  const userPrompt = await withReferenceContext(lines.join('\n'), {
    projectPath: input.projectPath,
    summarize: true,
    llm,
  });

  // 1) Upload bytes
  onPhase?.('uploading');
  const mime = input.videoMimeType ?? 'video/mp4';
  const uploaded = await uploadVideo(
    gemini.apiKey,
    input.videoPath,
    mime,
    `${input.sceneName} recording`,
  );

  let activeFile: GeminiFile;
  try {
    // 2) Wait for Gemini's server-side analysis to finish
    onPhase?.('processing');
    activeFile = await waitForFileActive(gemini.apiKey, uploaded.name, {
      onPoll: (state) => {
        if (state !== 'ACTIVE') onPhase?.('processing', state);
      },
    });

    // 3) Run generateContent with the video as a part
    onPhase?.('generating');
    const text = await generateWithVideo({
      apiKey: gemini.apiKey,
      model: gemini.model,
      systemPrompt,
      userPrompt,
      videoFileUri: activeFile.uri,
      videoMimeType: mime,
      temperature: 0.8,
    });

    onPhase?.('done');
    return text.trim();
  } finally {
    // Best-effort cleanup. Don't block the success path.
    void deleteFile(gemini.apiKey, uploaded.name);
  }
}
