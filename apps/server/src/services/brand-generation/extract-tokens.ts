import type { LlmClient } from '../llm/index.js';
import { DesignMdFrontMatter } from '@vpa/shared';

export interface ExtractTokensInput {
  systemPrompt: string;
  sourceMarkdown: string;
  brandName: string;
}

export interface ExtractTokensResult {
  frontMatter: DesignMdFrontMatter;
  rawResponse: string;
}

const STRICTER_HINT = '\n\nThe previous response was not valid JSON. Output ONLY a single JSON object — no prose, no code fences. Begin with `{` and end with `}`.';

export async function extractTokens(
  llm: LlmClient,
  input: ExtractTokensInput,
): Promise<ExtractTokensResult> {
  const userPrompt = `<<NAME=${input.brandName}>>\n\n${input.sourceMarkdown}`;

  let lastRaw = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const sys = attempt === 0 ? input.systemPrompt : input.systemPrompt + STRICTER_HINT;
    const out = await llm.complete({
      systemPrompt: sys,
      userPrompt,
      responseFormat: 'json',
      temperature: 0.2,
    });
    lastRaw = out.text;
    const cleaned = stripFences(lastRaw);
    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      continue;
    }
    const validated = DesignMdFrontMatter.safeParse(parsed);
    if (!validated.success) {
      throw new Error(
        `LLM returned valid JSON but it failed schema validation: ${validated.error.message}\nraw response: ${lastRaw}`,
      );
    }
    return { frontMatter: validated.data, rawResponse: lastRaw };
  }

  throw new Error(`LLM returned invalid JSON after 2 attempts. raw response: ${lastRaw}`);
}

function stripFences(s: string): string {
  return s.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
}
