import type { LlmClient } from '../llm/index.js';
import { loadPrompt } from '../llm/index.js';

export interface ScriptInput {
  sceneName: string;
  sceneDescription: string;
  sceneType: string;
  durationSec?: number;
  projectObjective?: string;
  projectAudience?: string;
}

export async function generateScript(
  input: ScriptInput,
  llm: LlmClient,
  workspaceRoot: string,
): Promise<string> {
  const systemPrompt = await loadPrompt(workspaceRoot, 'narration-writer');

  const lines = [
    `Scene: ${input.sceneName}`,
    `Description: ${input.sceneDescription}`,
    `Type: ${input.sceneType}`,
  ];

  if (input.durationSec) {
    lines.push(`Duration: ${input.durationSec.toFixed(1)} seconds`);
    const targetWords = Math.round((input.durationSec / 60) * 150);
    lines.push(`Target word count: ~${targetWords} words`);
  }

  if (input.projectObjective) {
    lines.push(`Project objective: ${input.projectObjective}`);
  }

  if (input.projectAudience) {
    lines.push(`Target audience: ${input.projectAudience}`);
  }

  const result = await llm.complete({
    systemPrompt,
    userPrompt: lines.join('\n'),
    temperature: 0.8,
  });

  return result.text.trim();
}
