/**
 * Resolve the color palette to use for lower-thirds rendering on a given
 * project. Falls back gracefully through three tiers:
 *
 *   1. Project's applied brand → `vpa.lower_thirds.{bg, fg}` extension —
 *      the brand author has explicitly set lower-third colors.
 *   2. Applied brand → `colors.primary` for the accent stripe (with a
 *      neutral text/bg pair).
 *   3. No brand applied → a confident default (deep teal stripe) that
 *      reads on both light and dark recordings.
 *
 * Used by `services/overlay/render.ts` AND surfaced through an HTTP
 * endpoint so the in-app Scene Preview can mirror the exact same colors.
 */

import { readFile } from 'node:fs/promises';
import matter from 'gray-matter';
import yaml from 'js-yaml';
import { DesignMdFrontMatter, ProjectSchema, type Project } from '@vpa/shared';
import { brandPaths } from '../brand/paths.js';
import { loadYaml } from '../../lib/yaml.js';

export interface LtColors {
  /** Hex (#RRGGBB) — the left-edge accent stripe. */
  accent: string;
  /** Hex (#RRGGBB) — text color (title + subtitle). */
  textColor: string;
  /** Hex (#RRGGBB) — solid container fill. Used by `solid` and `frosted`
   *  styles with different opacities; minimal style uses a thin version
   *  of this so text stays readable on light backgrounds. */
  bgColor: string;
  /** Where the colors came from, for debugging / UI hints. */
  source: 'brand-vpa' | 'brand-primary' | 'default';
}

const DEFAULT_COLORS: LtColors = {
  accent: '#0EA5E9',     // deep teal — pops on most backgrounds, no clash with brand recognition
  textColor: '#FFFFFF',
  bgColor: '#000000',
  source: 'default',
};

/** Normalize 3-digit hex (#abc) to 6-digit (#aabbcc). */
function normalizeHex(hex: string): string {
  if (/^#[0-9A-Fa-f]{3}$/.test(hex)) {
    const [, a, b, c] = hex.match(/^#([0-9A-Fa-f])([0-9A-Fa-f])([0-9A-Fa-f])$/)!;
    return `#${a}${a}${b}${b}${c}${c}`.toUpperCase();
  }
  return hex.toUpperCase();
}

/**
 * Resolve a design.md token reference like `{colors.primary}` against the
 * given colors map. Returns the literal value when not a token.
 */
function resolveColorToken(value: string, colors: Record<string, string | undefined>): string | null {
  const m = /^\{colors\.([\w-]+)\}$/.exec(value);
  if (!m) return value;
  return colors[m[1]!] ?? null;
}

async function readProjectYaml(projectPath: string): Promise<Project | null> {
  try {
    const text = await readFile(`${projectPath}/project.yaml`, 'utf-8');
    // Use the project's own loader so ISO datetime strings stay as strings
    // (js-yaml's default schema would deserialize them into JS Date objects
    // and the Zod parse would fail).
    return loadYaml(text, ProjectSchema);
  } catch {
    return null;
  }
}

interface ResolveOpts {
  vpaHome: string;
  workspaceRoot: string;
}

export async function resolveLtColors(
  projectPath: string,
  opts: ResolveOpts,
): Promise<LtColors> {
  const project = await readProjectYaml(projectPath);
  const brandId = project?.brand?.id;
  if (!brandId) return DEFAULT_COLORS;

  // Read the brand's design.md directly. Mirrors what brand/store.readBrand
  // does but without pulling the full registry — we only need the front matter.
  const paths = brandPaths(opts.vpaHome, opts.workspaceRoot);
  let raw: string;
  try {
    raw = await readFile(paths.designMd(brandId), 'utf-8');
  } catch {
    return DEFAULT_COLORS;
  }
  let frontMatter;
  try {
    const parsed = matter(raw, {
      engines: {
        yaml: { parse: (s) => yaml.load(s) as object, stringify: (o) => yaml.dump(o) },
      },
    });
    frontMatter = DesignMdFrontMatter.parse(parsed.data);
  } catch {
    return DEFAULT_COLORS;
  }

  // The schema enforces `primary` to be present, but Record<string,T> still
  // gives us `string | undefined` here — guard explicitly.
  const primary = frontMatter.colors.primary;
  if (!primary) return DEFAULT_COLORS;

  // Tier 1: VPA-namespaced lower-thirds extension wins. Values may be
  // literal hex (#1B1D36) or token references like `{colors.primary}` that
  // we resolve against the brand's colors map.
  const lt = frontMatter.vpa?.lower_thirds;
  const colorsMap = frontMatter.colors as Record<string, string | undefined>;
  const ltBg = lt ? resolveColorToken(lt.bg, colorsMap) : null;
  const ltFg = lt ? resolveColorToken(lt.fg, colorsMap) : null;
  const hexRegex = /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/;
  if (ltBg && ltFg && hexRegex.test(ltBg) && hexRegex.test(ltFg)) {
    return {
      accent: normalizeHex(primary),
      bgColor: normalizeHex(ltBg),
      textColor: normalizeHex(ltFg),
      source: 'brand-vpa',
    };
  }

  // Tier 2: just use the brand's primary as the accent
  return {
    accent: normalizeHex(primary),
    textColor: '#FFFFFF',
    bgColor: '#000000',
    source: 'brand-primary',
  };
}
