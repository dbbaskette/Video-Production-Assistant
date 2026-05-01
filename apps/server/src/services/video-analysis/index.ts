import type { LlmClient } from '../llm/index.js';
import { loadPrompt } from '../llm/index.js';

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
}

export async function analyzeRecording(
  input: AnalysisInput,
  llm: LlmClient,
  workspaceRoot: string,
): Promise<SceneAnalysis> {
  const systemPrompt = await loadPrompt(workspaceRoot, 'scene-description');

  const userPrompt = [
    `Scene ${input.sceneIndex + 1} of ${input.totalScenes}`,
    `Filename: ${input.filename}`,
    `Duration: ${input.duration_sec.toFixed(1)} seconds`,
    `Resolution: ${input.width}x${input.height}`,
    input.projectObjective ? `Project objective: ${input.projectObjective}` : '',
  ].filter(Boolean).join('\n');

  const result = await llm.complete({
    systemPrompt,
    userPrompt,
    responseFormat: 'json',
    temperature: 0.7,
  });

  const parsed = JSON.parse(result.text);
  return {
    name: parsed.name ?? `Scene ${input.sceneIndex + 1}`,
    description: parsed.description ?? 'Recording uploaded',
    type: parsed.type ?? 'desktop',
  };
}
