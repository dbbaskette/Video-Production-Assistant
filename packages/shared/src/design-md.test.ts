import { describe, it, expect } from 'vitest';
import { DesignMdFrontMatter, VpaExtensions } from './design-md.js';

const VALID_FM = {
  version: 'alpha',
  name: 'Tanzu',
  colors: {
    primary: '#007B8C',
    secondary: '#6C4B94',
    neutral: '#FFFFFF',
    'on-surface': '#000000',
  },
  typography: {
    'headline-lg': { fontFamily: 'Arial', fontSize: '36px', fontWeight: 700, lineHeight: 1.2 },
    'body-md':     { fontFamily: 'Arial', fontSize: '16px', fontWeight: 400, lineHeight: 1.5 },
  },
  rounded: { sm: '0px', md: '0px', lg: '0px' },
  spacing: { xs: '4px', sm: '8px', md: '16px', lg: '24px' },
  components: {
    'button-primary': { backgroundColor: '{colors.primary}', textColor: '{colors.neutral}' },
  },
};

describe('DesignMdFrontMatter', () => {
  it('accepts a valid Google-spec front matter object', () => {
    const parsed = DesignMdFrontMatter.parse(VALID_FM);
    expect(parsed.name).toBe('Tanzu');
    expect(parsed.version).toBe('alpha');
  });

  it('rejects invalid hex color', () => {
    const bad = {
      ...VALID_FM,
      colors: { ...VALID_FM.colors, primary: 'not-a-color' },
    };
    expect(() => DesignMdFrontMatter.parse(bad)).toThrow();
  });

  it('rejects colors without a primary entry', () => {
    const bad = {
      ...VALID_FM,
      colors: { secondary: '#6C4B94', neutral: '#FFFFFF' },
    };
    expect(() => DesignMdFrontMatter.parse(bad)).toThrow(/primary/);
  });

  it('accepts vpa extensions when present', () => {
    const withVpa = {
      ...VALID_FM,
      vpa: {
        voice: { tone: 'Confident, technical', avoid: ['jargon'] },
        audio: { music_mood: 'uplifting', sonic_logo: null },
        logo: { primary: null, mono: null, safe_zone_ratio: 0.25 },
        lower_thirds: { template: 'bar-left-accent', bg: '{colors.primary}', fg: '{colors.neutral}' },
        taglines: ['Ideas to code, code to production'],
      },
    };
    const parsed = DesignMdFrontMatter.parse(withVpa);
    expect(parsed.vpa?.voice.tone).toBe('Confident, technical');
  });

  it('accepts typography with CSS dimension fontSize', () => {
    const parsed = DesignMdFrontMatter.parse(VALID_FM);
    const headline = parsed.typography['headline-lg'] as { fontSize?: string };
    expect(headline.fontSize).toBe('36px');
  });

  it('accepts rounded with CSS dimension values', () => {
    const parsed = DesignMdFrontMatter.parse(VALID_FM);
    expect(parsed.rounded['sm']).toBe('0px');
  });

  it('accepts 3-digit hex colors', () => {
    const fm = {
      ...VALID_FM,
      colors: { primary: '#0AF', neutral: '#FFF', 'on-surface': '#000' },
    };
    const parsed = DesignMdFrontMatter.parse(fm);
    expect(parsed.colors['primary']).toBe('#0AF');
  });

  it('defaults version to "alpha" when omitted', () => {
    const { version: _, ...noVersion } = VALID_FM;
    const parsed = DesignMdFrontMatter.parse(noVersion);
    expect(parsed.version).toBe('alpha');
  });

  it('allows passthrough of unknown top-level fields for future spec compat', () => {
    const withExtra = { ...VALID_FM, elevation: { sm: '2px', md: '4px' } };
    const parsed = DesignMdFrontMatter.parse(withExtra);
    expect((parsed as any).elevation).toBeDefined();
  });
});
