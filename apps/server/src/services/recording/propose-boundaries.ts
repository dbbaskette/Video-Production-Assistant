import type { LlmClient } from '../llm/index.js';
import { loadPrompt } from '../llm/index.js';
import type { SceneBoundary } from './split.js';

export async function proposeBoundaries(
  metadata: { duration_sec: number; filename: string },
  llm: LlmClient,
  workspaceRoot: string,
): Promise<SceneBoundary[]> {
  const systemPrompt = await loadPrompt(workspaceRoot, 'scene-splitter');

  const userPrompt = [
    `Filename: ${metadata.filename}`,
    `Duration: ${metadata.duration_sec.toFixed(1)} seconds`,
  ].join('\n');

  const result = await llm.complete({
    systemPrompt,
    userPrompt,
    responseFormat: 'json',
    temperature: 0.7,
  });

  const parsed: unknown = JSON.parse(result.text);
  if (!Array.isArray(parsed)) {
    throw new Error('Scene splitter LLM did not return an array');
  }

  return parsed.map((item: any) => ({
    start_sec: Number(item.start_sec),
    end_sec: Number(item.end_sec),
    suggested_name: String(item.suggested_name ?? 'Untitled Scene'),
  }));
}
