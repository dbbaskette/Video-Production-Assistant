import { describe, it, expect, vi } from 'vitest';
import { writeRationale } from './write-rationale.js';

describe('writeRationale', () => {
  const fm = {
    version: 'alpha',
    name: 'Tanzu',
    colors: { primary: '#0091DA', neutral: '#FFFFFF', 'on-surface': '#1A1C1E' },
    typography: {
      'headline-lg': { fontFamily: 'Inter', fontSize: '36px', fontWeight: 600, lineHeight: 1.2 },
      'body-md': { fontFamily: 'Inter', fontSize: '16px', fontWeight: 400, lineHeight: 1.5 },
    },
    rounded: { sm: '4px', md: '8px', lg: '16px' },
    spacing: { xs: '4px', sm: '8px' },
    components: {},
  };

  it('passes the front matter as JSON to the LLM and returns prose', async () => {
    const llm = { complete: vi.fn(async () => ({ text: '## Overview\n\nWritten by LLM' })) };
    const out = await writeRationale(llm, { systemPrompt: 'sys', frontMatter: fm });
    expect(out).toContain('## Overview');
    expect(llm.complete).toHaveBeenCalledOnce();
    const call = (llm.complete as any).mock.calls[0][0];
    expect(call.userPrompt).toContain('Tanzu');
    expect(call.responseFormat).toBe('text');
  });

  it('strips a leading front matter block if the LLM mistakenly includes one', async () => {
    const llm = { complete: vi.fn(async () => ({ text: '---\nname: Tanzu\n---\n\n## Overview\n\nbody' })) };
    const out = await writeRationale(llm, { systemPrompt: 'sys', frontMatter: fm });
    expect(out).not.toMatch(/^---/);
    expect(out).toContain('## Overview');
  });
});
