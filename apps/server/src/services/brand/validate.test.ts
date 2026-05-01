import { describe, it, expect } from 'vitest';
import { validateBrand, BRAND_OK, BrandValidationIssue } from './validate.js';

const OK_FRONTMATTER = {
  version: 'alpha',
  name: 'Tanzu',
  colors: { primary: '#007B8C', neutral: '#FFFFFF', 'on-surface': '#1A1C1E' },
  typography: {
    'headline-lg': { fontFamily: 'Arial', fontSize: '36px', fontWeight: 700, lineHeight: 1.2 },
    'body-md': { fontFamily: 'Arial', fontSize: '16px', fontWeight: 400, lineHeight: 1.5 },
  },
  rounded: { sm: '0px', md: '0px', lg: '0px' },
  spacing: { xs: '4px', sm: '8px', md: '16px' },
  components: {
    'button-primary': { backgroundColor: '{colors.primary}', textColor: '{colors.neutral}' },
  },
};

describe('validateBrand', () => {
  it('returns BRAND_OK for valid brand with safe contrast', () => {
    const result = validateBrand({ frontMatter: OK_FRONTMATTER, body: '## Overview' });
    expect(result.status).toBe(BRAND_OK);
    expect(result.warnings).toEqual([]);
  });

  it('warns when component textColor on backgroundColor fails AA', () => {
    const fm = {
      ...OK_FRONTMATTER,
      colors: { primary: '#CCCCCC', neutral: '#AAAAAA', 'on-surface': '#000000' },
    };
    const result = validateBrand({ frontMatter: fm, body: '' });
    expect(result.status).toBe(BRAND_OK);
    const contrastWarnings = result.warnings.filter((w: BrandValidationIssue) => w.code === 'low-contrast');
    expect(contrastWarnings.length).toBeGreaterThan(0);
  });

  it('returns errors when front matter fails schema', () => {
    const fm = { ...OK_FRONTMATTER, colors: { primary: 'not-hex', neutral: '#FFF' } };
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
        lower_thirds: { template: 'bar-left-accent' as const, bg: '{colors.neutral}', fg: '{colors.neutral}' },
        taglines: [],
      },
    };
    const result = validateBrand({ frontMatter: fm, body: '' });
    const ltContrast = result.warnings.find((w: BrandValidationIssue) => w.code === 'low-contrast' && w.field?.startsWith('vpa.lower_thirds'));
    expect(ltContrast).toBeDefined();
  });
});
