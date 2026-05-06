import type { LlmClient } from '../llm/index.js';
import { loadPrompt } from '../llm/prompts.js';
import type { LowerThird } from '@vpa/shared';
import { withReferenceContext } from '../project-source-docs/inject.js';

export interface LowerThirdInput {
  sceneName: string;
  sceneDescription: string;
  sceneType: string;
  /**
   * User-authored "what is this scene demonstrating?" — the north star.
   * When provided, the prompt leads with this so LT titles reinforce
   * the intent rather than the auto-generated description.
   */
  sceneIntent?: string;
  durationSec?: number;
  projectObjective?: string;
  projectAudience?: string;
  /** When provided, the project's source-docs are prepended to the prompt. */
  projectPath?: string;
}

export async function recommendLowerThirds(
  input: LowerThirdInput,
  llm: LlmClient,
  workspaceRoot: string,
): Promise<LowerThird[]> {
  const systemPrompt = await loadPrompt(workspaceRoot, 'lower-third-recommender');

  // Same order-of-authority as the video-grounded variant.
  const parts: string[] = [];
  if (input.sceneIntent) {
    parts.push(`What this scene is demonstrating (north star): ${input.sceneIntent}`);
  }
  if (input.projectObjective) parts.push(`Project objective: ${input.projectObjective}`);
  if (input.projectAudience) parts.push(`Target audience: ${input.projectAudience}`);
  parts.push(`Scene name: ${input.sceneName}`);
  parts.push(`Auto-generated description (supporting context): ${input.sceneDescription}`);
  parts.push(`Type: ${input.sceneType}`);
  if (input.durationSec !== undefined) {
    parts.push(`Recording duration: ${input.durationSec}s`);
  }

  const userPrompt = await withReferenceContext(parts.join('\n'), {
    projectPath: input.projectPath,
    summarize: true,
    llm,
  });

  const result = await llm.complete({
    systemPrompt,
    userPrompt,
    responseFormat: 'json',
    temperature: 0.7,
  });

  // Parse the JSON response — expect an array of lower-third objects
  const text = result.text.trim();
  // Handle both raw array and ```json fenced responses
  const jsonStr = text.startsWith('[') ? text : text.replace(/^```json\s*/, '').replace(/```\s*$/, '');
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
}
