import { describe, it, expect } from 'vitest';
import { assembleDesignMd } from './assemble.js';

describe('assembleDesignMd', () => {
  const fm = {
    name: 'Tanzu', version: 1,
    colors: { primary: '#0091DA', surface: '#FFFFFF', on_surface: '#1A1C1E' },
    typography: { heading: { family: 'Inter', weights: [600] }, body: { family: 'Inter', weights: [400] } },
    rounded: { sm: 4, md: 8, lg: 16 },
    spacing: { unit: 8, scale: [4, 8] },
    components: {},
  };

  it('produces design.md text that round-trips through gray-matter', async () => {
    const matter = (await import('gray-matter')).default;
    const text = assembleDesignMd(fm, '## Overview\n\nbody');
    expect(text.startsWith('---\n')).toBe(true);
    const parsed = matter(text);
    expect(parsed.data.name).toBe('Tanzu');
    expect(parsed.content.trim()).toMatch(/^## Overview/);
  });

  it('puts a single blank line between front matter and body', () => {
    const text = assembleDesignMd(fm, 'body');
    expect(text).toMatch(/---\n\nbody/);
  });
});
