import path from 'node:path';
import {
  runFfmpeg as defaultRunFfmpeg,
  probeDuration as defaultProbeDuration,
} from '../render/index.js';
import type { FlatFrame, FrameEntry, PerspectiveFrame } from './manifest.js';

// ── Public types ──────────────────────────────────────────────────────────────

export interface RenderFramedOpts {
  /** Absolute path to input video. */
  inputVideo: string;
  /** A FrameEntry from the manifest (flat or perspective). */
  frameEntry: FrameEntry;
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

// ── Shared helpers ────────────────────────────────────────────────────────────

/**
 * Throws a uniform error if a transparent background is requested.
 * mp4 has no alpha channel — callers that need alpha must use a lossless
 * container, which is future work.
 */
function assertBgColorOpaque(bgColor: string): void {
  if (bgColor === 'transparent') {
    throw new Error(
      "Transparent backgrounds not supported for frames yet — mp4 doesn't carry alpha. Use a hex color instead.",
    );
  }
}

/** Convert `#RRGGBB` → `0xRRGGBB` so the value is safe to embed in a filter graph. */
function hexToFfmpegColor(hex: string): string {
  return hex.replace(/^#/, '0x');
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
  assertBgColorOpaque(bgColor);

  if (entry.type !== 'flat') {
    throw new Error(`buildFlatFilter only handles flat frames; got type '${(entry as { type: string }).type}'`);
  }

  const { frameSize, inset } = entry;

  const ffColor = hexToFfmpegColor(bgColor);

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
  //    `shortest=1` makes the overlay output end with the (finite) video, so
  //    the looped 86400s `color=` source doesn't drive the output duration.
  const underStep = `${bg}${padded}overlay=${inset.x}:${inset.y}:shortest=1${under}`;

  // 5. Overlay the frame PNG on top (device chrome over the video).
  const outStep = `${under}[1:v]overlay=0:0:format=auto${out}`;

  return [scaleStep, padStep, bgStep, underStep, outStep].join(';');
}

/**
 * Build the ffmpeg `-filter_complex` string for perspective (tilted) frame
 * compositing.
 *
 * Input streams:
 *   [0:v] — the input video
 *   [1:v] — the frame PNG (still image, looped to match duration)
 *
 * Geometry strategy ("scale-to-frame, no pre-pad"):
 *
 *   We scale the input video to the FULL frame canvas dimensions before the
 *   perspective warp. With the source already at FRAME_W × FRAME_H, its four
 *   corners are exactly (0,0), (FRAME_W,0), (FRAME_W,FRAME_H), (0,FRAME_H).
 *   In `sense=destination` mode the perspective filter takes the four
 *   destination corners — i.e. where the input's top-left, top-right,
 *   bottom-left, and bottom-right should land in the output. We therefore
 *   pass the quad corners directly: tl → (x0,y0), tr → (x1,y1),
 *   bl → (x2,y2), br → (x3,y3). The warped output is still FRAME_W × FRAME_H,
 *   with the visible video pixels confined to the quad. Anything that
 *   warps outside the quad gets hidden by the frame PNG overlay on top.
 *
 *   The alternative — pre-padding the source to the frame canvas at a
 *   bounding-box offset — is harder to reason about because the perspective
 *   filter warps the entire canvas (including the padding) and you have
 *   to think carefully about where the visible video corners actually end
 *   up. Scaling to frame size avoids that math entirely.
 *
 * Corner ordering note:
 *   The manifest's QuadSchema exports {tl, tr, br, bl} but ffmpeg's
 *   `perspective` filter wants (tl, tr, bl, br). Map carefully.
 *
 * Throws for `'transparent'` — mp4 does not carry an alpha channel.
 */
export function buildPerspectiveFilter(entry: PerspectiveFrame, bgColor: string): string {
  assertBgColorOpaque(bgColor);

  if (entry.type !== 'perspective') {
    throw new Error(
      `buildPerspectiveFilter only handles perspective frames; got type '${(entry as { type: string }).type}'`,
    );
  }

  const { frameSize, quad } = entry;
  const ffColor = hexToFfmpegColor(bgColor);

  // Stream labels
  const scaled = '[scaled]';
  const warped = '[warped]';
  const bg = '[bg]';
  const under = '[under]';
  const out = '[out]';

  // 1. Scale the input video to the full frame canvas. format=yuva420p keeps
  //    an alpha channel so any pixels the perspective warp leaves uncovered
  //    remain transparent (and get filled by the bg overlay below).
  const scaleStep = `[0:v]scale=${frameSize.w}:${frameSize.h},format=yuva420p${scaled}`;

  // 2. Apply the perspective warp. Destination-corner order is tl, tr, bl, br
  //    — note this differs from the manifest's tl, tr, br, bl ordering.
  const perspectiveStep =
    `${scaled}perspective=` +
    `x0=${quad.tl.x}:y0=${quad.tl.y}:` +
    `x1=${quad.tr.x}:y1=${quad.tr.y}:` +
    `x2=${quad.bl.x}:y2=${quad.bl.y}:` +
    `x3=${quad.br.x}:y3=${quad.br.y}:` +
    `sense=destination:` +
    `interpolation=linear${warped}`;

  // 3. Solid-colour background canvas matching the full frame dimensions.
  const bgStep = `color=c=${ffColor}:s=${frameSize.w}x${frameSize.h}:d=86400,format=yuva420p${bg}`;

  // 4. Composite warped video over the background. The perspective output is
  //    already frame-sized and positioned in the output space, so overlay at 0:0.
  //    `shortest=1` ends the stream when the (finite) video does — the
  //    background `color=` source has `d=86400` to be safe, and would otherwise
  //    drive a 24-hour output.
  const underStep = `${bg}${warped}overlay=0:0:shortest=1:format=auto${under}`;

  // 5. Overlay the frame PNG on top (device chrome over the warped video).
  const outStep = `${under}[1:v]overlay=0:0:format=auto${out}`;

  return [scaleStep, perspectiveStep, bgStep, underStep, outStep].join(';');
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
    // Dispatch on entry.type. Both builders throw for 'transparent' — the
    // error propagates to the caller before any ffmpeg work happens.
    const filterComplex =
      frameEntry.type === 'flat'
        ? buildFlatFilter(frameEntry, backgroundColor)
        : buildPerspectiveFilter(frameEntry, backgroundColor);

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
      '-pix_fmt', 'yuv420p',
      '-c:a', 'copy',
      outputPath,
    ];

    await _runFfmpeg(args);
  };
}
