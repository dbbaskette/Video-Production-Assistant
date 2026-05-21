import type { LlmClient } from '../llm/index.js';
import { loadPrompt } from '../llm/index.js';

export interface TightenInput {
  /** The existing script to compress. */
  currentScript: string;
  /** Target spoken duration in seconds — drives the target word count (~150 wpm). */
  targetDurationSec: number;
  /** Optional context so the model knows what scene it's editing. */
  sceneName?: string;
  sceneIntent?: string;
}

export interface TightenResult {
  proposedScript: string;
  currentWords: number;
  targetWords: number;
  proposedWords: number;
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

export async function tightenScript(
  input: TightenInput,
  llm: LlmClient,
  workspaceRoot: string,
): Promise<TightenResult> {
  const systemPrompt = await loadPrompt(workspaceRoot, 'narration-tighten');
  const targetWords = Math.max(20, Math.round((input.targetDurationSec / 60) * 150));

  const lines: string[] = [];
  if (input.sceneName) lines.push(`Scene: ${input.sceneName}`);
  if (input.sceneIntent) lines.push(`What this scene is demonstrating: ${input.sceneIntent}`);
  lines.push(`Target duration: ${input.targetDurationSec.toFixed(1)} seconds`);
  lines.push(`Target word count: ~${targetWords} words (current: ${wordCount(input.currentScript)} words)`);
  lines.push('');
  lines.push('Current script:');
  lines.push(input.currentScript);

  const result = await llm.complete({
    systemPrompt,
    userPrompt: lines.join('\n'),
  });

  const proposedScript = result.text.trim();
  return {
    proposedScript,
    currentWords: wordCount(input.currentScript),
    targetWords,
    proposedWords: wordCount(proposedScript),
  };
}
