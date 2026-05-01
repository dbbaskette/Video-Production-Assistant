import type { LlmClient } from '../llm/index.js';
import { loadPrompt } from '../llm/prompts.js';
import type { LowerThird } from '@vpa/shared';

export interface LowerThirdInput {
  sceneName: string;
  sceneDescription: string;
  sceneType: string;
  durationSec?: number;
}

export async function recommendLowerThirds(
  input: LowerThirdInput,
  llm: LlmClient,
  workspaceRoot: string,
): Promise<LowerThird[]> {
  const systemPrompt = await loadPrompt(workspaceRoot, 'lower-third-recommender');

  const parts = [
    `Scene: ${input.sceneName}`,
    `Description: ${input.sceneDescription}`,
    `Type: ${input.sceneType}`,
  ];
  if (input.durationSec !== undefined) {
    parts.push(`Recording duration: ${input.durationSec}s`);
  }

  const result = await llm.complete({
    systemPrompt,
    userPrompt: parts.join('\n'),
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
