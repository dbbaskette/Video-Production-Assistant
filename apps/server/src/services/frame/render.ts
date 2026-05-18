import path from 'node:path';
import {
  runFfmpeg as defaultRunFfmpeg,
  probeDuration as defaultProbeDuration,
} from '../render/index.js';
import type { FlatFrame } from './manifest.js';

// ── Public types ──────────────────────────────────────────────────────────────

export interface RenderFramedOpts {
  /** Absolute path to input video. */
  inputVideo: string;
  /** A FlatFrame entry from the manifest. */
  frameEntry: FlatFrame;
  /** Absolute path to the assets dir holding the frame PNGs.
   *  Combined with frameEntry.frame to resolve the PNG path. */
  assetsDir: string;
  /** Background color — either a hex '#RRGGBB' or 'transparent'.
   *  Transparent is not yet supported for mp4 output (no alpha channel). */
  backgroundColor: string;
  /** Absolute path to write the framed video. */
  outputPath: string;
}

export interface FrameRenderer {
  (opts: RenderFramedOpts): Promise<void>;
}

export interface FfmpegRunner {
  (args: string[]): Promise<void>;
}

export interface DurationProber {
  (path: string): Promise<number>;
}

// ── Pure filter-graph builder ─────────────────────────────────────────────────

/**
 * Build the ffmpeg `-filter_complex` string for flat frame compositing.
 *
 * Input streams:
 *   [0:v] — the input video
 *   [1:v] — the frame PNG (still image, looped to match duration)
 *
 * Strategy:
 *   1. Scale input to fit inside the inset, preserving aspect ratio.
 *   2. Pad the scaled result to the exact inset dimensions (letterboxing).
 *   3. Compose onto a solid-colour background matching the full frame size.
 *   4. Overlay the frame PNG on top so the device chrome sits over the video.
 *
 * Throws for `'transparent'` — mp4 does not carry an alpha channel.
 * Callers that need alpha must use a lossless container (future work).
 */
export function buildFlatFilter(entry: FlatFrame, bgColor: string): string {
  if (bgColor === 'transparent') {
    throw new Error(
      "Transparent backgrounds not supported for flat frames yet — mp4 doesn't carry alpha. Use a hex color instead.",
    );
  }

  if (entry.type !== 'flat') {
    throw new Error(`buildFlatFilter only handles flat frames; got type '${(entry as { type: string }).type}'`);
  }

  const { frameSize, inset } = entry;

  // Convert #RRGGBB → 0xRRGGBB for shell-safe ffmpeg color expressions.
  const ffColor = bgColor.replace(/^#/, '0x');

  // Stream labels
  const scaled = '[scaled]';
  const padded = '[padded]';
  const bg = '[bg]';
  const under = '[under]';
  const out = '[out]';

  // 1. Scale input video to fit inside inset, preserving aspect ratio.
  const scaleStep = `[0:v]scale=${inset.w}:${inset.h}:force_original_aspect_ratio=decrease,format=yuva420p${scaled}`;

  // 2. Pad to exact inset dimensions, centering the scaled video.
  //    Background of the letterbox bars uses the same colour as the overall bg.
  const padStep = `${scaled}pad=${inset.w}:${inset.h}:(ow-iw)/2:(oh-ih)/2:color=${ffColor}${padded}`;

  // 3. Solid-colour background canvas matching the full frame dimensions.
  //    Duration is controlled by `-t DURATION` on the frame PNG input;
  //    the color filter's `d=` is set to a safe upper bound (86400 s = 24 h).
  const bgStep = `color=c=${ffColor}:s=${frameSize.w}x${frameSize.h}:d=86400,format=yuva420p${bg}`;

  // 4. Overlay the padded video onto the background at the inset position.
  const underStep = `${bg}${padded}overlay=${inset.x}:${inset.y}${under}`;

  // 5. Overlay the frame PNG on top (device chrome over the video).
  const outStep = `${under}[1:v]overlay=0:0:format=auto${out}`;

  return [scaleStep, padStep, bgStep, underStep, outStep].join(';');
}

// ── Frame renderer factory ────────────────────────────────────────────────────

/**
 * Create a flat-frame renderer with optional DI points for testing.
 *
 * @param opts.runFfmpeg   - ffmpeg invocation (defaults to the shared helper in services/render).
 * @param opts.probeDuration - duration probe (defaults to the shared helper in services/render).
 *
 * @example
 * // Production use
 * const render = createFrameRenderer();
 *
 * // Test use
 * const render = createFrameRenderer({ runFfmpeg: fakeRunner, probeDuration: fakeProbe });
 */
export function createFrameRenderer(opts?: {
  runFfmpeg?: FfmpegRunner;
  probeDuration?: DurationProber;
}): FrameRenderer {
  const _runFfmpeg = opts?.runFfmpeg ?? defaultRunFfmpeg;
  const _probeDuration = opts?.probeDuration ?? defaultProbeDuration;

  return async function renderFramed({
    inputVideo,
    frameEntry,
    assetsDir,
    backgroundColor,
    outputPath,
  }: RenderFramedOpts): Promise<void> {
    // buildFlatFilter throws for 'transparent' — propagate immediately.
    const filterComplex = buildFlatFilter(frameEntry, backgroundColor);

    // Probe the input so we can cap the looped still image to the same length.
    const duration = await _probeDuration(inputVideo);

    const framePng = path.join(assetsDir, frameEntry.frame);

    const args = [
      '-y',
      // Input 0: the video to be framed
      '-i', inputVideo,
      // Input 1: the device frame PNG — loop as a still image, capped to input duration
      '-loop', '1', '-t', String(duration), '-i', framePng,
      // Composite filter
      '-filter_complex', filterComplex,
      // Map the composited video stream; audio comes from input 0
      '-map', '[out]',
      '-map', '0:a?',
      // Encode
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '20',
      '-c:a', 'copy',
      outputPath,
    ];

    await _runFfmpeg(args);
  };
}
