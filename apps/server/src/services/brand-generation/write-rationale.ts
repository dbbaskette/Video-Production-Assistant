import type { LlmClient } from '../llm/index.js';
import type { DesignMdFrontMatter } from '@vpa/shared';

export interface WriteRationaleInput {
  systemPrompt: string;
  frontMatter: DesignMdFrontMatter;
}

export async function writeRationale(
  llm: LlmClient,
  input: WriteRationaleInput,
): Promise<string> {
  const userPrompt = `Finalized design tokens (front matter):\n\n\`\`\`json\n${JSON.stringify(input.frontMatter, null, 2)}\n\`\`\`\n\nWrite the markdown body now.`;
  const out = await llm.complete({
    systemPrompt: input.systemPrompt,
    userPrompt,
    responseFormat: 'text',
    temperature: 0.6,
  });
  return stripLeadingFrontMatter(out.text).trim();
}

function stripLeadingFrontMatter(s: string): string {
  if (!s.trimStart().startsWith('---')) return s;
  const trimmed = s.trimStart();
  const end = trimmed.indexOf('\n---', 3);
  if (end < 0) return s;
  return trimmed.slice(end + 4).replace(/^\n+/, '');
}
