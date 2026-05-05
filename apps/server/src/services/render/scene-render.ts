/**
 * Per-scene render — produces three deliverable files in
 *   <projectRoot>/renders/scenes/<sceneId>/
 *     ├── combined.mp4   video + LT + narration (the all-in-one)
 *     ├── overlay.mp4    video + LT only (or raw recording if no LTs)
 *     └── narration.mp3  joined narration audio (omitted if no narration)
 *
 * Independent of the project-level render. Useful when the user wants to
 * grab one scene to drop into another editor (Premiere / Resolve / etc.)
 * without going through the full final-cut concat.
 *
 * Reuses the project render's helpers (runFfmpeg, probeDuration,
 * escapeForFilter, RenderError) so the ffmpeg behaviour and error mapping
 * stay consistent.
 */

import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Scene } from '@vpa/shared';
import { loadStoryboard, saveStoryboard, updateScene } from '../storyboard/index.js';
import { renderLowerThirdsOverlay } from '../overlay/render.js';
import { resolveLtColors } from '../overlay/colors.js';
import { RenderError, runFfmpeg, probeDuration, escapeForFilter } from './index.js';

export interface SingleSceneRenderOptions {
  audioMode?: 'replace' | 'mix';
  burnSubtitles?: boolean;
}

export interface SingleSceneRenderResult {
  /** Absolute paths so the caller (route) can stat / serve them directly. */
  combinedPath: string;
  overlayPath: string;
  narrationPath: string | null;  // null when the scene has no narration
  /** Relative-to-project paths so the response can be persisted in storyboard.yaml if desired. */
  combinedRel: string;
  overlayRel: string;
  narrationRel: string | null;
  durationSec: number;
  hadLowerThirds: boolean;
}

interface Deps {
  projectPath: string;
  sceneId: string;
  vpaHome: string;
  workspaceRoot: string;
}

export async function renderSingleScene(
  deps: Deps,
  opts: SingleSceneRenderOptions = {},
): Promise<SingleSceneRenderResult> {
  const { projectPath, sceneId, vpaHome, workspaceRoot } = deps;
  const audioMode = opts.audioMode ?? 'replace';

  // 1. Load + validate
  const sb = await loadStoryboard(projectPath);
  if (!sb) {
    throw new RenderError('No storyboard found', { hint: 'Build the storyboard first' });
  }
  const scene = sb.scenes.find((s) => s.id === sceneId);
  if (!scene) {
    throw new RenderError(`Scene not found: ${sceneId}`);
  }
  if (!scene.recording?.source) {
    throw new RenderError('Scene has no recording', {
      hint: 'Upload a recording for this scene before rendering',
    });
  }

  // 2. Output directory
  const outDirRel = join('renders', 'scenes', sceneId);
  const outDir = join(projectPath, outDirRel);
  await mkdir(outDir, { recursive: true });

  // 3. Produce overlay.mp4
  const overlayRel = join(outDirRel, 'overlay.mp4');
  const overlayPath = join(projectPath, overlayRel);
  const recordingPath = join(projectPath, scene.recording.source);
  const hasLts = (scene.lower_thirds?.length ?? 0) > 0;
  const existingOverlay = scene.overlay_render
    ? join(projectPath, scene.overlay_render)
    : null;

  if (hasLts && existingOverlay && existsSync(existingOverlay)) {
    // Reuse the most recent baked overlay — avoids the slow drawtext pass.
    await copyFile(existingOverlay, overlayPath);
  } else if (hasLts) {
    // No prior overlay (or its file is gone) → render fresh now and update
    // storyboard so subsequent calls hit the fast path above.
    const colors = await resolveLtColors(projectPath, { vpaHome, workspaceRoot });
    const result = await renderLowerThirdsOverlay({
      projectPath,
      sceneId,
      recordingPath,
      lowerThirds: scene.lower_thirds!,
      colors,
    });
    const renderedAt = join(projectPath, result.outputPath);
    await copyFile(renderedAt, overlayPath);
    const updated = updateScene(sb, sceneId, { overlay_render: result.outputPath });
    await saveStoryboard(projectPath, updated);
  } else {
    // No LTs at all — overlay.mp4 is just a copy of the raw recording so
    // the per-scene folder always has a "video" file in a predictable spot.
    await copyFile(recordingPath, overlayPath);
  }

  // 4. Produce narration.mp3 (joined from chunks if needed)
  const narrationRel = join(outDirRel, 'narration.mp3');
  const narrationPath = await prepareNarrationAudio(projectPath, scene, outDir, narrationRel);

  // 5. Mux combined.mp4 — overlay video + narration audio
  const combinedRel = join(outDirRel, 'combined.mp4');
  const combinedPath = join(projectPath, combinedRel);
  const burnSubtitles = !!opts.burnSubtitles && !!scene.narration?.subtitles?.srt;
  const srtPath = scene.narration?.subtitles?.srt
    ? join(projectPath, scene.narration.subtitles.srt)
    : null;

  await muxOne({
    videoPath: overlayPath,
    audioPath: narrationPath,
    audioMode,
    burnSubtitles,
    srtPath,
    outputPath: combinedPath,
  });

  const durationSec = await probeDuration(combinedPath);

  return {
    combinedPath,
    overlayPath,
    narrationPath,
    combinedRel,
    overlayRel,
    narrationRel: narrationPath ? narrationRel : null,
    durationSec,
    hadLowerThirds: hasLts,
  };
}

/**
 * Resolve narration to a single mp3. Mirrors the project render's
 * `prepareSceneAudio` but always re-encodes to mp3 so callers get a
 * consistent file format on the way to a third-party editor.
 */
async function prepareNarrationAudio(
  projectPath: string,
  scene: Scene,
  outDir: string,
  outRel: string,
): Promise<string | null> {
  const narration = scene.narration;
  if (!narration) return null;
  const outPath = join(projectPath, outRel);

  // Legacy single-file narration path takes priority if present.
  if (narration.audio) {
    const full = join(projectPath, narration.audio);
    if (existsSync(full)) {
      await runFfmpeg(['-y', '-i', full, '-c:a', 'libmp3lame', '-b:a', '192k', outPath]);
      return outPath;
    }
  }

  const chunks = (narration.chunks ?? []).filter((c) => c.audio);
  if (chunks.length === 0) return null;

  if (chunks.length === 1) {
    const full = join(projectPath, chunks[0]!.audio!);
    if (!existsSync(full)) return null;
    await runFfmpeg(['-y', '-i', full, '-c:a', 'libmp3lame', '-b:a', '192k', outPath]);
    return outPath;
  }

  // Multi-chunk: concat-demux into a single mp3.
  const sortedChunks = [...chunks].sort((a, b) => a.index - b.index);
  const concatList = join(outDir, '.audio-list.txt');
  const lines = sortedChunks
    .map((c) => `file '${join(projectPath, c.audio!).replace(/'/g, "'\\''")}'`)
    .join('\n');
  await writeFile(concatList, lines);
  await runFfmpeg([
    '-y', '-f', 'concat', '-safe', '0', '-i', concatList,
    '-c:a', 'libmp3lame', '-b:a', '192k',
    outPath,
  ]);
  return outPath;
}

interface MuxOpts {
  videoPath: string;
  audioPath: string | null;
  audioMode: 'replace' | 'mix';
  burnSubtitles: boolean;
  srtPath: string | null;
  outputPath: string;
}

/**
 * Mux a single overlay video + optional narration into combined.mp4.
 * Same audio-routing semantics as the project render's per-scene mux:
 *   replace → drop original, use only narration (trimmed to video length)
 *   mix     → narration full volume, original recording at -20 dB
 */
async function muxOne(opts: MuxOpts): Promise<void> {
  const args: string[] = ['-y', '-i', opts.videoPath];
  if (opts.audioPath) args.push('-i', opts.audioPath);

  if (opts.burnSubtitles && opts.srtPath) {
    args.push('-vf', `subtitles=${escapeForFilter(opts.srtPath)}`);
  }

  if (opts.audioPath) {
    if (opts.audioMode === 'replace') {
      args.push('-map', '0:v:0', '-map', '1:a:0');
      args.push('-c:v', opts.burnSubtitles ? 'libx264' : 'copy');
      args.push('-c:a', 'aac', '-b:a', '192k');
      args.push('-shortest');
    } else {
      args.push(
        '-filter_complex',
        '[0:a]volume=0.1[a0];[1:a]volume=1.0[a1];[a0][a1]amix=inputs=2:duration=longest[aout]',
      );
      args.push('-map', '0:v:0', '-map', '[aout]');
      args.push('-c:v', opts.burnSubtitles ? 'libx264' : 'copy');
      args.push('-c:a', 'aac', '-b:a', '192k');
    }
  } else {
    // No narration — combined.mp4 is just an overlay re-mux.
    args.push('-c', 'copy');
  }

  args.push(opts.outputPath);
  await runFfmpeg(args);
}
