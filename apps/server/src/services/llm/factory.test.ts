import { describe, expect, it } from 'vitest';
import { createLlm, createLlmFromEntry } from './factory.js';

describe('LLM factory provider validation', () => {
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
