import { describe, it, expect } from 'vitest';
import { assembleDesignMd } from './assemble.js';

describe('assembleDesignMd', () => {
  const fm = {
    version: 'alpha',
    name: 'Tanzu',
    colors: { primary: '#007B8C', neutral: '#FFFFFF', 'on-surface': '#000000' },
    typography: {
      'headline-lg': { fontFamily: 'Arial', fontSize: '36px', fontWeight: 700, lineHeight: 1.2 },
      'body-md': { fontFamily: 'Arial', fontSize: '16px', fontWeight: 400, lineHeight: 1.5 },
    },
    rounded: { sm: '0px', md: '0px', lg: '0px' },
    spacing: { xs: '4px', sm: '8px', md: '16px' },
    components: {},
  };

  it('produces design.md text that round-trips through gray-matter', async () => {
    const matter = (await import('gray-matter')).default;
    const text = assembleDesignMd(fm, '## Overview\n\nbody');
    expect(text.startsWith('---\n')).toBe(true);
    const parsed = matter(text);
    expect(parsed.data.name).toBe('Tanzu');
    expect(parsed.data.version).toBe('alpha');
    expect(parsed.content.trim()).toMatch(/^## Overview/);
  });

  it('puts a single blank line between front matter and body', () => {
    const text = assembleDesignMd(fm, 'body');
    expect(text).toMatch(/---\n\nbody/);
  });
});
