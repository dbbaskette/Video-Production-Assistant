import type { LlmClient } from '../llm/index.js';
import { loadPrompt } from '../llm/index.js';
import { withReferenceContext } from '../project-source-docs/inject.js';

export interface ScriptInput {
  sceneName: string;
  sceneDescription: string;
  sceneType: string;
  /**
   * User-authored "what is this scene demonstrating?" — the north star for
   * narration. When present, the prompt structure leads with this; the
   * video (if any) is paced/visual anchor; source-docs are factual detail.
   * When absent, falls back to the older description-led behaviour.
   */
  sceneIntent?: string;
  durationSec?: number;
  projectObjective?: string;
  projectAudience?: string;
  /** When provided, the project's source-docs are prepended to the prompt. */
  projectPath?: string;
}

export async function generateScript(
  input: ScriptInput,
  llm: LlmClient,
  workspaceRoot: string,
): Promise<string> {
  const systemPrompt = await loadPrompt(workspaceRoot, 'narration-writer');

  // Order matters: lead with the *purpose* (what this scene is teaching),
  // then objective/audience/scope, then auto-generated description as
  // supporting context. The prompt template tells the model that intent is
  // authoritative — description is a hint, not a directive.
  const lines: string[] = [];
  if (input.sceneIntent) {
    lines.push(`What this scene is demonstrating (north star): ${input.sceneIntent}`);
  }
  if (input.projectObjective) {
    lines.push(`Project objective: ${input.projectObjective}`);
  }
  if (input.projectAudience) {
    lines.push(`Target audience: ${input.projectAudience}`);
  }
  lines.push(`Scene name: ${input.sceneName}`);
  lines.push(`Auto-generated description (supporting context): ${input.sceneDescription}`);
  lines.push(`Type: ${input.sceneType}`);
  if (input.durationSec) {
    lines.push(`Duration: ${input.durationSec.toFixed(1)} seconds`);
    const targetWords = Math.round((input.durationSec / 60) * 150);
    lines.push(`Target word count: ~${targetWords} words`);
  }

  const userPrompt = await withReferenceContext(lines.join('\n'), {
    projectPath: input.projectPath,
    summarize: true,
    llm,
  });

  const result = await llm.complete({
    systemPrompt,
    userPrompt,
    temperature: 0.8,
  });

  return result.text.trim();
}
