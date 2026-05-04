import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { LowerThird } from '@vpa/shared';
import { projectFiles } from '../project/paths.js';
import { probeVideo } from '../recording/metadata.js';

const execFileAsync = promisify(execFile);

export interface OverlayRenderInput {
  projectPath: string;
  sceneId: string;
  recordingPath: string;   // absolute path to the MP4
  lowerThirds: LowerThird[];
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

/**
 * Default accent color for the left-edge stripe — a warm amber that pops
 * against most demo recordings without clashing. Hex (no leading #) for
 * ffmpeg drawbox color syntax.
 */
const ACCENT_HEX = 'F4A83A';

/**
 * Build a drawbox + drawtext filter chain for a single lower-third entry,
 * scaled to the video's resolution. One container box, one accent stripe,
 * title + subtitle drawn on top — visually matches the in-app Preview tab.
 */
function buildLowerThirdFilters(
  lt: LowerThird,
  dims: { width: number; height: number },
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

  const bgColor = lt.style === 'solid'
    ? 'black@0.85'
    : lt.style === 'minimal'
      ? null               // no container in minimal style
      : 'black@0.55';      // frosted

  const filters: string[] = [];

  // 1. Container background (skipped in minimal style)
  if (bgColor) {
    filters.push(
      `drawbox=x=${boxX}:y=${boxY}:w=${boxW}:h=${boxH}:color=${bgColor}:t=fill:${enable}`,
    );
  }

  // 2. Accent stripe — always shown, even in minimal, so the LT has a
  //    visual anchor.
  filters.push(
    `drawbox=x=${boxX}:y=${boxY}:w=${stripeW}:h=${boxH}:color=0x${ACCENT_HEX}@1.0:t=fill:${enable}`,
  );

  // 3. Title text
  const textShadow = lt.style === 'minimal'
    ? 'shadowx=2:shadowy=2:shadowcolor=black@0.85'
    : '';
  const titleArgs = [
    `text='${escapedTitle}'`,
    `fontsize=${titleSize}`,
    `x=${textX}`,
    `y=${titleY}`,
    'fontcolor=white',
  ];
  if (textShadow) titleArgs.push(textShadow);
  titleArgs.push(enable);
  filters.push(`drawtext=${titleArgs.join(':')}`);

  // 4. Subtitle text (slightly muted relative to title)
  if (escapedSubtitle) {
    const subArgs = [
      `text='${escapedSubtitle}'`,
      `fontsize=${subtitleSize}`,
      `x=${textX}`,
      `y=${subtitleY}`,
      'fontcolor=0xE0E0E0',
    ];
    if (textShadow) subArgs.push(textShadow);
    subArgs.push(enable);
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

  // 2. Build the filter chain
  const allFilters = lowerThirds.flatMap((lt) => buildLowerThirdFilters(lt, dims));
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
