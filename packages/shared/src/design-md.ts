import { z } from 'zod';

const HexColor = z.string().regex(/^#([0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/, 'Must be #RRGGBB or #RRGGBBAA');
const FontWeight = z.number().int().min(100).max(900).refine((n) => n % 100 === 0, 'Weight must be a 100-step value');

const Typography = z.object({
  heading: z.object({ family: z.string().min(1), weights: z.array(FontWeight).min(1) }),
  body:    z.object({ family: z.string().min(1), weights: z.array(FontWeight).min(1) }),
}).strict();

const Spacing = z.object({
  unit: z.number().int().positive(),
  scale: z.array(z.number().int().positive()).min(1).refine(
    (arr) => arr.every((v, i) => i === 0 || v >= (arr[i - 1] ?? v)),
    'Spacing scale must be non-decreasing',
  ),
}).strict();

const Rounded = z.object({
  sm: z.number().int().nonnegative(),
  md: z.number().int().nonnegative(),
  lg: z.number().int().nonnegative(),
}).strict();

const Colors = z.object({
  primary:    HexColor,
  surface:    HexColor,
  on_surface: HexColor,
  accent:     HexColor.optional(),
}).catchall(HexColor);

export const VpaExtensions = z.object({
  voice: z.object({
    tone: z.string(),
    avoid: z.array(z.string()).default([]),
  }).strict(),
  audio: z.object({
    music_mood: z.string().nullable(),
    sonic_logo: z.string().nullable(),
  }).strict(),
  logo: z.object({
    primary: z.string().nullable(),
    mono:    z.string().nullable(),
    safe_zone_ratio: z.number().min(0).max(1).default(0.25),
  }).strict(),
  lower_thirds: z.object({
    template: z.enum(['bar-left-accent', 'centered-fade', 'minimal-line']),
    bg: z.string(),
    fg: z.string(),
  }).strict(),
  taglines: z.array(z.string()).default([]),
}).strict();

export type VpaExtensions = z.infer<typeof VpaExtensions>;

export const DesignMdFrontMatter = z.object({
  name: z.string().min(1).max(80),
  version: z.number().int().positive(),
  description: z.string().optional(),
  colors: Colors,
  typography: Typography,
  rounded: Rounded,
  spacing: Spacing,
  components: z.record(z.string(), z.unknown()).default({}),
  vpa: VpaExtensions.optional(),
}).strict();

export type DesignMdFrontMatter = z.infer<typeof DesignMdFrontMatter>;

export const DesignMd = z.object({
  frontMatter: DesignMdFrontMatter,
  body: z.string(),
});
export type DesignMd = z.infer<typeof DesignMd>;
