import { describe, it, expect } from 'vitest';
import { createFakeLlm } from './fake.js';

describe('createFakeLlm', () => {
  it('returns a deterministic JSON design.md when prompt asks for tokens', async () => {
    const llm = createFakeLlm();
    const out = await llm.complete({
      systemPrompt: 'extract design tokens',
      userPrompt: 'My brand is bold and clean',
      responseFormat: 'json',
    });
    const parsed = JSON.parse(out.text);
    expect(parsed.name).toBeDefined();
    expect(parsed.version).toBe('alpha');
    expect(parsed.colors.primary).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(parsed.typography['headline-lg']).toBeDefined();
    expect(parsed.typography['headline-lg'].fontFamily).toBeDefined();
    expect(parsed.vpa).toBeDefined();
  });

  it('returns prose markdown when responseFormat is text', async () => {
    const llm = createFakeLlm();
    const out = await llm.complete({
      systemPrompt: 'write rationale',
      userPrompt: '{"name":"Test"}',
      responseFormat: 'text',
    });
    expect(out.text).toMatch(/##\s+Overview/);
    expect(out.text).toMatch(/##\s+Colors/);
    expect(out.text).toMatch(/##\s+Typography/);
  });

  it('honors a seeded brand name from the user prompt for stability', async () => {
    const llm = createFakeLlm();
    const out = await llm.complete({
      systemPrompt: 'extract',
      userPrompt: '<<NAME=Acme>>\nAcme is bold.',
      responseFormat: 'json',
    });
    expect(JSON.parse(out.text).name).toBe('Acme');
  });
});
