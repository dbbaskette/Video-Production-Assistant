import { describe, it, expect } from 'vitest';
import { validateBrand, BRAND_OK, BrandValidationIssue } from './validate.js';

const OK_FRONTMATTER = {
  name: 'Tanzu',
  version: 1,
  colors: { primary: '#0091DA', surface: '#FFFFFF', on_surface: '#1A1C1E' },
  typography: { heading: { family: 'Inter', weights: [600] }, body: { family: 'Inter', weights: [400] } },
  rounded: { sm: 4, md: 8, lg: 16 },
  spacing: { unit: 8, scale: [4, 8, 16] },
  components: {},
};

describe('validateBrand', () => {
  it('returns BRAND_OK for valid brand with safe contrast', () => {
    const result = validateBrand({ frontMatter: OK_FRONTMATTER, body: '## Overview' });
    expect(result.status).toBe(BRAND_OK);
    expect(result.warnings).toEqual([]);
  });

  it('warns when on_surface on surface fails AA', () => {
    const fm = { ...OK_FRONTMATTER, colors: { primary: '#0091DA', surface: '#CCCCCC', on_surface: '#AAAAAA' } };
    const result = validateBrand({ frontMatter: fm, body: '' });
    expect(result.status).toBe(BRAND_OK);
    const contrastWarnings = result.warnings.filter((w: BrandValidationIssue) => w.code === 'low-contrast');
    expect(contrastWarnings.length).toBeGreaterThan(0);
  });

  it('returns errors when front matter fails schema', () => {
    const fm = { ...OK_FRONTMATTER, colors: { primary: 'not-hex', surface: '#FFF', on_surface: '#000' } };
    const result = validateBrand({ frontMatter: fm as any, body: '' });
    expect(result.status).toBe('invalid');
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('resolves {colors.x} references in lower_thirds for contrast check', () => {
    const fm = {
      ...OK_FRONTMATTER,
      vpa: {
        voice: { tone: 'x', avoid: [] },
        audio: { music_mood: null, sonic_logo: null },
        logo: { primary: null, mono: null, safe_zone_ratio: 0.25 },
        lower_thirds: { template: 'bar-left-accent' as const, bg: '{colors.surface}', fg: '{colors.surface}' },
        taglines: [],
      },
    };
    const result = validateBrand({ frontMatter: fm, body: '' });
    const ltContrast = result.warnings.find((w: BrandValidationIssue) => w.code === 'low-contrast' && w.field?.startsWith('vpa.lower_thirds'));
    expect(ltContrast).toBeDefined();
  });
});
