/**
 * Scene analysis — turns a freshly uploaded (or already-ingested) recording
 * into a `{name, description, type}` triple that seeds the storyboard.
 *
 * Two modes:
 *   • text-only (default) — uses metadata + project objective/audience +
 *     project source-docs. Cheap, works with any LLM provider.
 *   • video-grounded (Gemini-only) — additionally uploads the recording to
 *     Gemini's Files API so the model can describe what's actually on
 *     screen rather than guessing from the filename. Mirrors the
 *     video-grounded narration flow in services/video-narration/.
 *
 * The route picks the mode based on a `groundInVideo` flag + whether the
 * active provider can accept video.
 */

import type { LlmClient } from '../llm/index.js';
import { loadPrompt } from '../llm/index.js';
import { withReferenceContext } from '../project-source-docs/inject.js';
import {
  uploadVideo,
  waitForFileActive,
  generateWithVideo,
  deleteFile,
} from '../video-narration/gemini-files.js';

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

export interface GeminiVideoConfig {
  apiKey: string;
  model: string;
}

export type VideoAnalysisPhase =
  | 'uploading'
  | 'processing'
  | 'generating'
  | 'done';

/**
 * Build the user-prompt text shared by both modes. Pulled out of
 * analyzeRecording so the video-grounded path can reuse the exact same
 * scene metadata + source-docs assembly without duplicating the lines.
 */
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

export interface VideoAnalysisInput extends AnalysisInput {
  /** Absolute path to the scene's recording on disk. */
  videoPath: string;
  /** Default 'video/mp4'. */
  videoMimeType?: string;
}

/**
 * Video-grounded scene analysis. Uploads the recording to Gemini's Files
 * API, polls until ACTIVE, then runs `generateContent` with the file URI
 * as a part. Same metadata + source-docs flow on top.
 *
 * Falls back to text-only is the route's responsibility — this function
 * always uses the video.
 */
export async function analyzeRecordingWithVideo(
  input: VideoAnalysisInput,
  gemini: GeminiVideoConfig,
  workspaceRoot: string,
  llm: LlmClient,
  onPhase?: (phase: VideoAnalysisPhase, detail?: string) => void,
): Promise<SceneAnalysis> {
  const systemPrompt = await loadPrompt(workspaceRoot, 'scene-description-video');
  const userPrompt = await buildUserPrompt(input, llm);
  const mime = input.videoMimeType ?? 'video/mp4';

  onPhase?.('uploading');
  const uploaded = await uploadVideo(
    gemini.apiKey,
    input.videoPath,
    mime,
    `${input.filename} (scene analysis)`,
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
    return parseAnalysis(text, input.sceneIndex);
  } finally {
    void deleteFile(gemini.apiKey, uploaded.name);
  }
}
