import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { LowerThird } from '@vpa/shared';
import { projectFiles } from '../project/paths.js';
import { probeVideo } from '../recording/metadata.js';
import type { LtColors } from './colors.js';

const execFileAsync = promisify(execFile);

export interface OverlayRenderInput {
  projectPath: string;
  sceneId: string;
  recordingPath: string;   // absolute path to the MP4
  lowerThirds: LowerThird[];
  /** Resolved palette (brand-aware or default). Falls back to defaults if omitted. */
  colors?: LtColors;
}

export interface OverlayRenderResult {
  outputPath: string;     // relative: overlays/scene-01-lower-thirds.mp4
  durationSec: number;
}

/**
 * Escape special characters for ffmpeg drawtext filter values.
 * The drawtext filter requires escaping of : ; ' \ and other chars.
 */
function escapeDrawtext(text: string): string {
  return text
    .replace(/\\/g, '\\\\\\\\')
    .replace(/'/g, "'\\\\\\''")
    .replace(/:/g, '\\:')
    .replace(/;/g, '\\;')
    .replace(/%/g, '%%');
}

/** Strip leading "#" from a hex color (ffmpeg drawbox/drawtext expect 6-digit hex). */
function ffhex(color: string): string {
  return color.replace(/^#/, '');
}

const FALLBACK_PALETTE = {
  accent: '0EA5E9',     // deep teal — the "no brand" default
  textColor: 'FFFFFF',
  bgColor: '000000',
};

/**
 * Build a drawbox + drawtext filter chain for a single lower-third entry,
 * scaled to the video's resolution. One container box, one accent stripe,
 * title + subtitle drawn on top — visually matches the in-app Preview tab.
 *
 * Style → background opacity (always non-zero so light recordings don't
 * hide white text):
 *   minimal — bg @ 0.40 (subtle backing, retains the "barely there" feel)
 *   frosted — bg @ 0.62 (default; can't blur in ffmpeg so we deepen instead)
 *   solid   — bg @ 0.88
 */
function buildLowerThirdFilters(
  lt: LowerThird,
  dims: { width: number; height: number },
  palette: { accent: string; textColor: string; bgColor: string },
): string[] {
  const { width: w, height: h } = dims;
  const enable = `enable='between(t,${lt.in_sec},${lt.out_sec})'`;
  const escapedTitle = escapeDrawtext(lt.title);
  const escapedSubtitle = lt.subtitle ? escapeDrawtext(lt.subtitle) : null;

  // Resolution-scaled sizing. These ratios were tuned against 1080p and 4K
  // demos; they keep the overlay readable across recording sizes.
  const titleSize = Math.max(20, Math.round(h * 0.04));
  const subtitleSize = Math.max(14, Math.round(h * 0.025));
  const padX = Math.max(12, Math.round(h * 0.014));
  const padY = Math.max(10, Math.round(h * 0.012));
  const stripeW = Math.max(4, Math.round(w * 0.003));
  const lineGap = Math.max(4, Math.round(h * 0.005));

  // Container geometry
  const innerH = escapedSubtitle
    ? padY + titleSize + lineGap + subtitleSize + padY
    : padY * 2 + titleSize;
  const boxX = Math.round(w * 0.04);
  const boxY = Math.round(h - h * 0.06 - innerH); // 6% gap from bottom edge
  const boxW = Math.min(Math.round(w * 0.6), w - boxX * 2);
  const boxH = innerH;

  // Text x always sits to the right of the accent stripe + a little gap
  const textX = boxX + stripeW + padX;
  const titleY = boxY + padY;
  const subtitleY = boxY + padY + titleSize + lineGap;

  // All styles get a container fill — the difference is opacity. This
  // guarantees white-on-light-background text stays readable, fixing the
  // "minimal LT washes out on a cream-coloured table" issue.
  const bgOpacity =
    lt.style === 'solid' ? 0.88 :
    lt.style === 'minimal' ? 0.40 :
    /* frosted */ 0.62;
  const bgHex = ffhex(palette.bgColor);
  const accentHex = ffhex(palette.accent);
  const textHex = ffhex(palette.textColor);
  const subtitleHex = textHex === 'FFFFFF' ? 'E0E0E0' : textHex;

  const filters: string[] = [];

  // 1. Container background (always present, always semi-transparent).
  filters.push(
    `drawbox=x=${boxX}:y=${boxY}:w=${boxW}:h=${boxH}:color=0x${bgHex}@${bgOpacity}:t=fill:${enable}`,
  );

  // 2. Accent stripe — left edge, full opacity. Anchors the LT visually
  //    and gives it brand identity when colors come from a brand kit.
  filters.push(
    `drawbox=x=${boxX}:y=${boxY}:w=${stripeW}:h=${boxH}:color=0x${accentHex}@1.0:t=fill:${enable}`,
  );

  // 3. Title — soft shadow on every style to handle busy backgrounds.
  const titleArgs = [
    `text='${escapedTitle}'`,
    `fontsize=${titleSize}`,
    `x=${textX}`,
    `y=${titleY}`,
    `fontcolor=0x${textHex}`,
    'shadowx=2:shadowy=2:shadowcolor=black@0.7',
    enable,
  ];
  filters.push(`drawtext=${titleArgs.join(':')}`);

  // 4. Subtitle — slightly muted; same shadow treatment.
  if (escapedSubtitle) {
    const subArgs = [
      `text='${escapedSubtitle}'`,
      `fontsize=${subtitleSize}`,
      `x=${textX}`,
      `y=${subtitleY}`,
      `fontcolor=0x${subtitleHex}`,
      'shadowx=2:shadowy=2:shadowcolor=black@0.7',
      enable,
    ];
    filters.push(`drawtext=${subArgs.join(':')}`);
  }

  return filters;
}

/**
 * Render lower-thirds overlays onto a recording video using ffmpeg drawtext filters.
 */
export async function renderLowerThirdsOverlay(
  input: OverlayRenderInput,
): Promise<OverlayRenderResult> {
  const { projectPath, sceneId, recordingPath, lowerThirds } = input;
  const files = projectFiles(projectPath);

  // 1. Create the overlays directory
  await mkdir(files.overlaysDir, { recursive: true });

  // 1a. Probe the recording so we can scale the lower-third sizes to its
  //     resolution — fixed-pixel font sizes look invisible on 4K recordings.
  const inputMeta = await probeVideo(recordingPath);
  const dims = { width: inputMeta.width || 1920, height: inputMeta.height || 1080 };

  // 1b. Resolve the color palette. Caller may pass colors (resolved via
  //     services/overlay/colors.resolveLtColors) or omit and accept defaults.
  const palette = {
    accent: input.colors?.accent ?? `#${FALLBACK_PALETTE.accent}`,
    textColor: input.colors?.textColor ?? `#${FALLBACK_PALETTE.textColor}`,
    bgColor: input.colors?.bgColor ?? `#${FALLBACK_PALETTE.bgColor}`,
  };

  // 2. Build the filter chain
  const allFilters = lowerThirds.flatMap((lt) => buildLowerThirdFilters(lt, dims, palette));
  const filterChain = allFilters.join(',');

  // 3. Determine output path
  const outputFilename = `${sceneId}-lower-thirds.mp4`;
  const outputAbsolute = join(files.overlaysDir, outputFilename);
  const outputRelative = `overlays/${outputFilename}`;

  // 4. Run ffmpeg. -vf forces a video re-encode; pin to libx264 with a
  //    sane CRF so the overlay doesn't degrade quality on long recordings.
  const args = [
    '-y',
    '-i', recordingPath,
    '-vf', filterChain,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'copy',
    outputAbsolute,
  ];

  try {
    await execFileAsync('ffmpeg', args);
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? '';
    const message = (err as Error).message ?? String(err);
    throw new OverlayRenderError(message, {
      stderrTail: stderr.slice(-2000),
      hint: hintFromStderr(stderr),
    });
  }

  // 5. Probe the output to get duration
  const metadata = await probeVideo(outputAbsolute);

  return {
    outputPath: outputRelative,
    durationSec: metadata.duration_sec,
  };
}

/**
 * Map known ffmpeg stderr patterns to a human-readable fix hint.
 * Same vocabulary as services/render so the UI can render either uniformly.
 */
function hintFromStderr(stderr: string): string | undefined {
  if (/No such filter:\s*'?drawtext'?/i.test(stderr)) {
    return "ffmpeg lacks freetype — see /setup. Reinstall via: brew install homebrew-ffmpeg/ffmpeg/ffmpeg";
  }
  if (/No such filter:\s*'?subtitles'?/i.test(stderr)) {
    return 'ffmpeg lacks libass — disable subtitle burn-in or rebuild ffmpeg with --enable-libass';
  }
  if (/Unable to choose an output format|No suitable output format/i.test(stderr)) {
    return 'Output filename must end with a recognized extension (.mp4, .mov, etc.)';
  }
  if (/Invalid data found when processing input/i.test(stderr)) {
    return 'The input recording is malformed — re-encode the source file';
  }
  return undefined;
}

export class OverlayRenderError extends Error {
  hint?: string;
  stderrTail?: string;
  constructor(message: string, opts: { hint?: string; stderrTail?: string } = {}) {
    super(message);
    this.name = 'OverlayRenderError';
    this.hint = opts.hint;
    this.stderrTail = opts.stderrTail;
  }
}

/**
 * Create a fake overlay renderer for testing.
 * Skips ffmpeg and just copies the input file to the overlay path.
 */
export function createFakeOverlayRenderer(): typeof renderLowerThirdsOverlay {
  return async (input: OverlayRenderInput): Promise<OverlayRenderResult> => {
    const { projectPath, sceneId, recordingPath } = input;
    const files = projectFiles(projectPath);

    await mkdir(files.overlaysDir, { recursive: true });

    const outputFilename = `${sceneId}-lower-thirds.mp4`;
    const outputAbsolute = join(files.overlaysDir, outputFilename);
    const outputRelative = `overlays/${outputFilename}`;

    await copyFile(recordingPath, outputAbsolute);

    return {
      outputPath: outputRelative,
      durationSec: 47.2,
    };
  };
}
