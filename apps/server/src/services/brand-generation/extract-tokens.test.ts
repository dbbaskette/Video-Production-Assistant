import { describe, it, expect, vi } from 'vitest';
import { extractTokens } from './extract-tokens.js';
import type { LlmClient } from '../llm/index.js';

const mkLlm = (responses: string[]): LlmClient => {
  let i = 0;
  return { complete: vi.fn(async () => ({ text: responses[i++]! })) };
};

const VALID_TOKENS = {
  version: 'alpha',
  name: 'Tanzu',
  colors: { primary: '#007B8C', neutral: '#FFFFFF', 'on-surface': '#000000' },
  typography: {
    'headline-lg': { fontFamily: 'Arial', fontSize: '36px', fontWeight: 700, lineHeight: 1.2 },
    'body-md': { fontFamily: 'Arial', fontSize: '16px', fontWeight: 400, lineHeight: 1.5 },
  },
  rounded: { sm: '0px', md: '0px' },
  spacing: { xs: '4px', sm: '8px' },
  components: {},
};

describe('extractTokens', () => {
  it('parses valid JSON returned by the LLM into DesignMdFrontMatter', async () => {
    const llm = mkLlm([JSON.stringify(VALID_TOKENS)]);
    const result = await extractTokens(llm, {
      systemPrompt: 'sys',
      sourceMarkdown: 'My brand is bold',
      brandName: 'Tanzu',
    });
    expect(result.frontMatter.name).toBe('Tanzu');
    expect(result.frontMatter.colors.primary).toBe('#007B8C');
    expect(result.frontMatter.version).toBe('alpha');
  });

  it('strips code fences if the LLM wraps JSON in them', async () => {
    const llm = mkLlm(['```json\n' + JSON.stringify(VALID_TOKENS) + '\n```']);
    const result = await extractTokens(llm, { systemPrompt: 's', sourceMarkdown: 'x', brandName: 'Tanzu' });
    expect(result.frontMatter.name).toBe('Tanzu');
  });

  it('retries once on invalid JSON, then succeeds', async () => {
    const llm = mkLlm(['not-json', JSON.stringify(VALID_TOKENS)]);
    const result = await extractTokens(llm, { systemPrompt: 's', sourceMarkdown: 'x', brandName: 'Tanzu' });
    expect(result.frontMatter.name).toBe('Tanzu');
    expect((llm.complete as any).mock.calls.length).toBe(2);
  });

  it('throws after a second invalid JSON, exposing raw text', async () => {
    const llm = mkLlm(['nope', 'still nope']);
    await expect(extractTokens(llm, { systemPrompt: 's', sourceMarkdown: 'x', brandName: 'Z' }))
      .rejects.toThrow(/raw response/);
  });

  it('throws when valid JSON fails the schema', async () => {
    const llm = mkLlm([JSON.stringify({ name: 'X' })]);
    await expect(extractTokens(llm, { systemPrompt: 's', sourceMarkdown: 'x', brandName: 'X' }))
      .rejects.toThrow();
  });
});
