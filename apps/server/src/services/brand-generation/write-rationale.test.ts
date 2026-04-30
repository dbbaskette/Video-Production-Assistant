import { describe, it, expect, vi } from 'vitest';
import { writeRationale } from './write-rationale.js';

describe('writeRationale', () => {
  const fm = {
    name: 'Tanzu', version: 1,
    colors: { primary: '#0091DA', surface: '#FFFFFF', on_surface: '#1A1C1E' },
    typography: { heading: { family: 'Inter', weights: [600] }, body: { family: 'Inter', weights: [400] } },
    rounded: { sm: 4, md: 8, lg: 16 },
    spacing: { unit: 8, scale: [4, 8] },
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
