/**
 * Build an inter-scene transition clip from freeze frames so the source
 * scenes never get cut.
 *
 * The original implementation ran ffmpeg `xfade` directly between the two
 * scene mp4s — that consumes the last N seconds of clip A and the first N
 * seconds of clip B (xfade overlaps both inputs across its duration). On
 * narrated demos that's bad: the speaker mid-sentence at the end of a scene
 * disappears into the transition, and the next scene's opening beat is
 * also eaten.
 *
 * Here we instead:
 *   1. Pull the last visible frame of A and the first visible frame of B
 *      out as PNGs.
 *   2. Build a standalone mp4 that holds frame A, xfades to frame B over
 *      the requested duration, and ends on frame B. Audio is silent.
 *   3. Concat that clip in between A and B as a hard cut on both seams.
 *
 * Net effect: A and B play in full; the transition becomes additive time
 * with smooth freeze-frame motion under the xfade effect. Background
 * music (mixed in a later pass) continues across the transition, so the
 * silent audio track on the transition clip itself doesn't create a gap
 * when music is in use.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { SceneTransition } from '@vpa/shared';
import { runFfmpeg } from './index.js';

const XFADE_FILTER_MAP: Record<Exclude<SceneTransition, 'cut'>, string> = {
  'crossfade': 'fade',
  'fade-black': 'fadeblack',
  'fade-white': 'fadewhite',
  'wipe-left': 'wipeleft',
  'wipe-right': 'wiperight',
  'slide-left': 'slideleft',
  'slide-right': 'slideright',
  'slide-up': 'slideup',
  'slide-down': 'slidedown',
  'circleopen': 'circleopen',
  'circleclose': 'circleclose',
  'radial': 'radial',
  'pixelize': 'pixelize',
};

export interface BuildTransitionClipOpts {
  /** Source video whose LAST frame anchors the start of the transition. */
  fromScenePath: string;
  /** Source video whose FIRST frame anchors the end of the transition. */
  toScenePath: string;
  transition: Exclude<SceneTransition, 'cut'>;
  /** Total duration of the transition clip, in seconds. */
  durationSec: number;
  /** Target dimensions — should match the scenes on either side so the
   *  concat pipeline doesn't have to re-scale during the join. */
  width: number;
  height: number;
  /** When true, the clip carries a silent audio stream so the outer concat
   *  doesn't have to special-case the missing track. The params (sample
   *  rate, channel layout) MUST match the surrounding scene mp4s — the
   *  concat-demuxer `-c copy` path fails silently (audio stream truncates,
   *  some players see 0:0.0) when sample rate or channel count differs. */
  hasAudio: boolean;
  /** Audio sample rate in Hz to match the surrounding scenes. Required when
   *  hasAudio is true. Probe one of the source scenes to get this. */
  audioSampleRate?: number;
  /** Channel layout string ffmpeg understands: "mono", "stereo", etc.
   *  Required when hasAudio is true. */
  audioChannelLayout?: string;
  /** Absolute path to write the transition mp4 to. */
  outputPath: string;
  /** Working directory for the extracted PNG frames. Caller owns lifecycle. */
  tmpDir: string;
  /** Unique tag so concurrent transition builds in the same tmp dir don't
   *  stomp on each other's frame PNGs. */
  cacheTag: string;
}

export async function buildTransitionClip(opts: BuildTransitionClipOpts): Promise<void> {
  const frameA = join(opts.tmpDir, `transition-${opts.cacheTag}-a.png`);
  const frameB = join(opts.tmpDir, `transition-${opts.cacheTag}-b.png`);

  // Pull the LAST frame from A. `-sseof -0.5` seeks half a second from
  // the end and `-frames:v 1` plus `-update 1` makes ffmpeg overwrite a
  // single output file as it decodes, leaving us with the final frame.
  await runFfmpeg([
    '-y',
    '-sseof', '-0.5',
    '-i', opts.fromScenePath,
    '-frames:v', '1',
    '-update', '1',
    '-q:v', '1',
    frameA,
  ]);
  // First frame of B is trivially the first decoded frame.
  await runFfmpeg([
    '-y',
    '-i', opts.toScenePath,
    '-frames:v', '1',
    '-q:v', '1',
    frameB,
  ]);

  if (!existsSync(frameA) || !existsSync(frameB)) {
    throw new Error(
      `transition-clip: frame extraction failed (a=${existsSync(frameA)}, b=${existsSync(frameB)})`,
    );
  }

  const xfadeName = XFADE_FILTER_MAP[opts.transition];
  const totalDur = opts.durationSec;

  // libx264 needs even dimensions for yuv420p chroma subsampling.
  const normW = opts.width + (opts.width % 2);
  const normH = opts.height + (opts.height % 2);

  // Both freeze inputs are loaded as still images held for `totalDur`
  // seconds. xfade(offset=0, duration=totalDur) blends across the whole
  // clip — at t=0 the viewer sees 100% A, at t=totalDur 100% B, smoothly
  // for every transition type. fps=60 + settb=1/90000 + setsar=1 mirror
  // the normalisation the outer concat applies elsewhere so the resulting
  // clip slots in without a re-encode pass.
  const videoFilter =
    `[0:v]fps=60,scale=${normW}:${normH}:force_original_aspect_ratio=decrease,` +
    `pad=${normW}:${normH}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,settb=1/90000[a];` +
    `[1:v]fps=60,scale=${normW}:${normH}:force_original_aspect_ratio=decrease,` +
    `pad=${normW}:${normH}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,settb=1/90000[b];` +
    `[a][b]xfade=transition=${xfadeName}:duration=${totalDur.toFixed(3)}:offset=0,settb=1/90000[v]`;

  const args: string[] = [
    '-y',
    '-loop', '1', '-t', totalDur.toFixed(3), '-i', frameA,
    '-loop', '1', '-t', totalDur.toFixed(3), '-i', frameB,
  ];

  if (opts.hasAudio) {
    // Silent track sized to the clip, with sample rate + channel layout
    // matching the surrounding scenes. Without the match, concat-demuxer
    // `-c copy` produces a corrupt mp4 (audio breaks, players show 0:0.0).
    const sr = opts.audioSampleRate ?? 44100;
    const cl = opts.audioChannelLayout && opts.audioChannelLayout.length > 0
      ? opts.audioChannelLayout
      : 'mono';
    args.push(
      '-f', 'lavfi',
      '-t', totalDur.toFixed(3),
      '-i', `anullsrc=channel_layout=${cl}:sample_rate=${sr}`,
    );
  }

  args.push(
    '-filter_complex', videoFilter,
    '-map', '[v]',
    ...(opts.hasAudio ? ['-map', '2:a'] : []),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    ...(opts.hasAudio ? ['-c:a', 'aac', '-b:a', '192k'] : ['-an']),
    '-movflags', '+faststart',
    opts.outputPath,
  );

  await runFfmpeg(args);
}
