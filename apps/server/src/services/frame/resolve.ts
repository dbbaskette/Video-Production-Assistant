/**
 * Per-scene frame resolution — combines storyboard defaults + scene overrides
 * into a concrete decision (which frame entry to use, what background colour
 * to fill, where the assets live).
 *
 * Returns `null` when no frame is requested at any level, so callers can
 * cheaply skip the frame pass with a single null check.
 *
 * Pure-ish: the only I/O is `resolveLtColors` when `frame_background: 'brand'`
 * is used, and that's injected through `opts.brandColorResolver` so the
 * resolver stays testable without touching the filesystem.
 */

import type { Scene, StoryboardDefaults } from '@vpa/shared';
import type { FrameEntry, FrameManifest } from './manifest.js';
import { getFrame } from './manifest.js';
import { resolveLtColors } from '../overlay/colors.js';

export interface ResolvedFrame {
  frameEntry: FrameEntry;
  /** Resolved background — hex `#RRGGBB` or the literal string `'transparent'`. */
  backgroundColor: string;
  /** Absolute path to the assets dir associated with the resolved manifest. */
  assetsDir: string;
}

/**
 * Resolves the brand's primary accent colour for a project. Defaults to the
 * production `resolveLtColors` implementation; tests can pass a fake.
 */
export interface BrandColorResolver {
  (projectPath: string, opts: { vpaHome: string; workspaceRoot: string }): Promise<string>;
}

export const defaultBrandColorResolver: BrandColorResolver = async (projectPath, opts) => {
  const colors = await resolveLtColors(projectPath, opts);
  // `accent` is the brand primary stripe colour — the closest analog to a
  // "brand colour" in our palette resolution. `bgColor`/`textColor` are
  // intentionally separate concerns (lower-thirds container fill / text).
  return colors.accent;
};

/** Plan-documented fallback when no background is configured. */
const DEFAULT_FRAME_BG = '#1a1a1a';

export interface ResolveSceneFrameOpts {
  scene: Scene;
  defaults: StoryboardDefaults | undefined;
  manifest: FrameManifest;
  assetsDir: string;
  projectPath: string;
  vpaHome: string;
  workspaceRoot: string;
  /** Test seam — defaults to `resolveLtColors().accent` against the project. */
  brandColorResolver?: BrandColorResolver;
}

/**
 * Walks the scene → defaults override chain and produces a concrete plan.
 *
 *   frame_style:      scene wins over defaults; both missing → no frame (null)
 *   frame_background: scene wins over defaults; both missing → DEFAULT_FRAME_BG
 *
 * Throws when `frame_style` is set but the manifest doesn't contain that id —
 * the caller is responsible for surfacing the error to the user.
 */
export async function resolveSceneFrame(
  opts: ResolveSceneFrameOpts,
): Promise<ResolvedFrame | null> {
  const styleId = opts.scene.frame_style ?? opts.defaults?.frame_style;
  if (!styleId) return null;

  const frameEntry = getFrame(opts.manifest, styleId);
  if (!frameEntry) {
    throw new Error(`Unknown frame_style: ${styleId}`);
  }

  const bg = opts.scene.frame_background ?? opts.defaults?.frame_background;
  const backgroundColor = await resolveBackgroundColor(bg, opts);

  return {
    frameEntry,
    backgroundColor,
    assetsDir: opts.assetsDir,
  };
}

async function resolveBackgroundColor(
  bg: string | undefined,
  opts: ResolveSceneFrameOpts,
): Promise<string> {
  if (!bg) return DEFAULT_FRAME_BG;
  if (bg === 'transparent') return 'transparent';
  if (bg === 'brand') {
    if (!opts.brandColorResolver) {
      // Guard against silent crashes when the production caller omitted the
      // path arguments that the default resolver depends on.
      if (!opts.vpaHome || !opts.workspaceRoot) {
        throw new Error(
          "Cannot resolve frame_background='brand': vpaHome and workspaceRoot are required, " +
            'or supply a brandColorResolver',
        );
      }
    }
    const resolver = opts.brandColorResolver ?? defaultBrandColorResolver;
    return resolver(opts.projectPath, {
      vpaHome: opts.vpaHome,
      workspaceRoot: opts.workspaceRoot,
    });
  }
  // Literal hex like '#1a2b3c' — schema already validated the format.
  return bg;
}

/**
 * Wraps a `BrandColorResolver` so the inner resolver is called at most once
 * per render. Subsequent calls with the same (or different) project path return
 * the memoised result without re-reading `design.md`.
 *
 * The cache key is intentionally project-agnostic: within a single render all
 * scenes belong to the same project, so the brand colour is constant. Use a
 * fresh wrapper per render if rendering multiple unrelated projects.
 */
export function createCachingBrandColorResolver(inner: BrandColorResolver): BrandColorResolver {
  let cached: string | null = null;
  return async (projectPath, opts) => {
    if (cached === null) {
      cached = await inner(projectPath, opts);
    }
    return cached;
  };
}
