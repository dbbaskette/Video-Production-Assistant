import { z } from 'zod';

// Google design.md spec: colors are 3- or 6-digit hex
const HexColor = z.string().regex(/^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/, 'Must be #RGB or #RRGGBB');

// CSS dimension string: "4px", "1.5rem", "-0.02em", "100%"
const CssDimension = z.string().regex(
  /^-?\d*\.?\d+(px|em|rem|%)$/,
  'Must be a CSS dimension (e.g. "4px", "1.5rem")',
);

// A single typography level (e.g. headline-lg, body-md)
const TypographyLevel = z.object({
  fontFamily: z.string().min(1),
  fontSize: CssDimension.optional(),
  fontWeight: z.number().int().min(100).max(900).optional(),
  lineHeight: z.union([CssDimension, z.number()]).optional(),
  letterSpacing: CssDimension.optional(),
  fontFeature: z.string().optional(),
  fontVariation: z.string().optional(),
});
export type TypographyLevel = z.infer<typeof TypographyLevel>;

// Colors: flat map, "primary" required
const Colors = z.record(z.string(), HexColor).refine(
  (c) => 'primary' in c,
  'colors must include a "primary" entry',
);

// Typography: map of named levels, at least one required
const Typography = z.record(z.string(), TypographyLevel).refine(
  (t) => Object.keys(t).length >= 1,
  'typography must have at least one level',
);

// Rounded: named scale levels → CSS dimensions ("0px", "4px", "8px")
const Rounded = z.record(z.string(), CssDimension);

// Spacing: named scale levels → CSS dimensions or numbers
const SpacingValue = z.union([CssDimension, z.number()]);
const Spacing = z.record(z.string(), SpacingValue);

// Component sub-tokens: key → string value or token reference
const ComponentTokens = z.record(z.string(), z.union([z.string(), z.number()]));

// --- VPA extensions (namespaced, ignored by Google linter) ---

export const VpaExtensions = z.object({
  voice: z.object({
    tone: z.string(),
    avoid: z.array(z.string()).default([]),
  }),
  audio: z.object({
    music_mood: z.string().nullable(),
    sonic_logo: z.string().nullable(),
  }),
  logo: z.object({
    primary: z.string().nullable(),
    mono:    z.string().nullable(),
    safe_zone_ratio: z.number().min(0).max(1).default(0.25),
  }),
  lower_thirds: z.object({
    template: z.enum(['bar-left-accent', 'centered-fade', 'minimal-line']),
    bg: z.string(),
    fg: z.string(),
  }),
  taglines: z.array(z.string()).default([]),
});

export type VpaExtensions = z.infer<typeof VpaExtensions>;

// --- Full design.md front matter (Google spec + VPA namespace) ---

export const DesignMdFrontMatter = z.object({
  version: z.string().default('alpha'),
  name: z.string().min(1).max(80),
  description: z.string().optional(),
  colors: Colors,
  typography: Typography,
  rounded: Rounded.default({}),
  spacing: Spacing.default({}),
  components: z.record(z.string(), ComponentTokens).default({}),
  vpa: VpaExtensions.optional(),
}).passthrough();
// passthrough allows future Google spec fields without breaking

export type DesignMdFrontMatter = z.infer<typeof DesignMdFrontMatter>;

export const DesignMd = z.object({
  frontMatter: DesignMdFrontMatter,
  body: z.string(),
});
export type DesignMd = z.infer<typeof DesignMd>;
