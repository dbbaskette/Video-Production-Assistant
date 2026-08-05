import { describe, expect, it } from 'vitest';
import { capabilitiesForProvider, createLlm, createLlmFromEntry } from './factory.js';

describe('LLM factory provider validation', () => {
  it('marks Gemini as the only image and video capable provider', () => {
    expect(capabilitiesForProvider('gemini')).toEqual({ text: true, image: true, video: true });
    expect(capabilitiesForProvider('anthropic')).toEqual({ text: true, image: false, video: false });
  });

  it('fails closed instead of constructing the deterministic fake for unknown providers', () => {
    expect(() => createLlm({ provider: 'unknown-provider' } as never))
      .toThrow('Unsupported LLM provider');
    expect(() => createLlmFromEntry({
      id: 'unknown',
      name: 'Unknown',
      provider: 'unknown-provider',
      model: 'unknown',
    } as never)).toThrow('Unsupported LLM provider');
  });
});
