import { describe, it, expect } from 'vitest';
import { DesignMdFrontMatter, VpaExtensions } from './design-md.js';

describe('DesignMdFrontMatter', () => {
  it('accepts a valid front matter object', () => {
    const valid = {
      name: 'Tanzu',
      version: 1,
      colors: { primary: '#0091DA', surface: '#FFFFFF', on_surface: '#1A1C1E' },
      typography: {
        heading: { family: 'Inter', weights: [600, 700] },
        body:    { family: 'Inter', weights: [400] },
      },
      rounded: { sm: 4, md: 8, lg: 16 },
      spacing: { unit: 8, scale: [4, 8, 16, 24] },
      components: {},
    };
    const parsed = DesignMdFrontMatter.parse(valid);
    expect(parsed.name).toBe('Tanzu');
  });

  it('rejects invalid hex color', () => {
    const bad = {
      name: 'Tanzu', version: 1,
      colors: { primary: 'not-a-color', surface: '#FFF', on_surface: '#000' },
      typography: { heading: { family: 'Inter', weights: [400] }, body: { family: 'Inter', weights: [400] } },
      rounded: { sm: 4, md: 8, lg: 16 },
      spacing: { unit: 8, scale: [4, 8] },
      components: {},
    };
    expect(() => DesignMdFrontMatter.parse(bad)).toThrow();
  });

  it('accepts vpa extensions when present', () => {
    const withVpa = {
      name: 'Tanzu', version: 1,
      colors: { primary: '#0091DA', surface: '#FFFFFF', on_surface: '#1A1C1E' },
      typography: { heading: { family: 'Inter', weights: [600] }, body: { family: 'Inter', weights: [400] } },
      rounded: { sm: 4, md: 8, lg: 16 },
      spacing: { unit: 8, scale: [4, 8] },
      components: {},
      vpa: {
        voice: { tone: 'Confident', avoid: ['jargon'] },
        audio: { music_mood: 'uplifting', sonic_logo: null },
        logo:  { primary: 'assets/logo.svg', mono: 'assets/logo-mono.png', safe_zone_ratio: 0.25 },
        lower_thirds: { template: 'bar-left-accent', bg: '{colors.primary}', fg: '{colors.on_surface}' },
        taglines: ['Build cloud-native, faster'],
      },
    };
    const parsed = DesignMdFrontMatter.parse(withVpa);
    expect(parsed.vpa?.voice.tone).toBe('Confident');
  });

  it('rejects unknown top-level fields', () => {
    const bad = {
      name: 'Tanzu', version: 1,
      colors: { primary: '#0091DA', surface: '#FFFFFF', on_surface: '#1A1C1E' },
      typography: { heading: { family: 'Inter', weights: [600] }, body: { family: 'Inter', weights: [400] } },
      rounded: { sm: 4, md: 8, lg: 16 },
      spacing: { unit: 8, scale: [4, 8] },
      components: {},
      not_a_real_field: 'oops',
    };
    expect(() => DesignMdFrontMatter.parse(bad)).toThrow();
  });
});
