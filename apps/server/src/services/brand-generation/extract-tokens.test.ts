import { describe, it, expect, vi } from 'vitest';
import { extractTokens } from './extract-tokens.js';
import type { LlmClient } from '../llm/index.js';

const mkLlm = (responses: string[]): LlmClient => {
  let i = 0;
  return { complete: vi.fn(async () => ({ text: responses[i++]! })) };
};

describe('extractTokens', () => {
  it('parses valid JSON returned by the LLM into DesignMdFrontMatter', async () => {
    const llm = mkLlm([JSON.stringify({
      name: 'Tanzu', version: 1,
      colors: { primary: '#0091DA', surface: '#FFFFFF', on_surface: '#1A1C1E' },
      typography: { heading: { family: 'Inter', weights: [600] }, body: { family: 'Inter', weights: [400] } },
      rounded: { sm: 4, md: 8, lg: 16 },
      spacing: { unit: 8, scale: [4, 8] },
      components: {},
    })]);
    const result = await extractTokens(llm, {
      systemPrompt: 'sys',
      sourceMarkdown: 'My brand is bold',
      brandName: 'Tanzu',
    });
    expect(result.frontMatter.name).toBe('Tanzu');
    expect(result.frontMatter.colors.primary).toBe('#0091DA');
  });

  it('strips code fences if the LLM wraps JSON in them', async () => {
    const llm = mkLlm(['```json\n' + JSON.stringify({
      name: 'X', version: 1,
      colors: { primary: '#000000', surface: '#FFFFFF', on_surface: '#000000' },
      typography: { heading: { family: 'I', weights: [400] }, body: { family: 'I', weights: [400] } },
      rounded: { sm: 4, md: 8, lg: 16 },
      spacing: { unit: 8, scale: [4] },
      components: {},
    }) + '\n```']);
    const result = await extractTokens(llm, { systemPrompt: 's', sourceMarkdown: 'x', brandName: 'X' });
    expect(result.frontMatter.name).toBe('X');
  });

  it('retries once on invalid JSON, then succeeds', async () => {
    const llm = mkLlm(['not-json', JSON.stringify({
      name: 'Y', version: 1,
      colors: { primary: '#000000', surface: '#FFFFFF', on_surface: '#000000' },
      typography: { heading: { family: 'I', weights: [400] }, body: { family: 'I', weights: [400] } },
      rounded: { sm: 4, md: 8, lg: 16 },
      spacing: { unit: 8, scale: [4] },
      components: {},
    })]);
    const result = await extractTokens(llm, { systemPrompt: 's', sourceMarkdown: 'x', brandName: 'Y' });
    expect(result.frontMatter.name).toBe('Y');
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
