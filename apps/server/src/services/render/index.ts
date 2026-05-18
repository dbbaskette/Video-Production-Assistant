import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rm, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadStoryboard, saveStoryboard, updateScene } from '../storyboard/index.js';
import type { Scene, Storyboard, StoryboardDefaults } from '@vpa/shared';
import {
  loadFrameManifest,
  defaultAssetsDir,
  type FrameManifest,
} from '../frame/manifest.js';
import { createFrameRenderer, type FrameRenderer } from '../frame/render.js';
import { resolveSceneFrame, type BrandColorResolver } from '../frame/resolve.js';

const execFileAsync = promisify(execFile);

export type RenderProgress = (event: {
  type: 'step';
  step: 'concat-audio' | 'mux-scene' | 'concat-scenes' | 'mix-music' | 'done';
  sceneIndex?: number;
  sceneId?: string;
  totalScenes?: number;
  message: string;
}) => void;

export interface RenderOptions {
  /** Replace original audio with narration (default) or mix narration over recording. */
  audioMode?: 'replace' | 'mix';
  /** Burn subtitles into the video instead of writing only the sidecar SRT. */
  burnSubtitles?: boolean;
  /**
   * Optional background music track. When provided, the music is looped
   * across the full video and mixed under the narration at `musicVolumeDb`
   * (default -20). The music is added in a final stage after scene concat.
   */
  music?: {
    audioPath: string;          // absolute path to the music file (mp3/wav)
    volumeDb?: number;          // gain offset in dB; -20 = quiet bed, 0 = full volume
  };
  /**
   * VPA install root — needed only when scenes/defaults request
   * `frame_background: 'brand'`, so the brand's primary color can be resolved.
   * Optional; falls back to a neutral gray when scenes use non-brand backgrounds.
   */
  vpaHome?: string;
  /** Workspace root — sibling of `vpaHome` for brand color resolution. */
  workspaceRoot?: string;
  /** Internal — DI seams for tests (manifest, frame renderer, brand resolver). */
  __frameDeps?: FramePrepDeps;
}

export interface RenderResult {
  outputPath: string;        // absolute path to renders/final.mp4
  scenePaths: string[];      // absolute paths to renders/scene-XX.mp4
  durationSec: number;
}

/**
 * Render a finished mp4 for the whole project: per-scene mux of recording
 * + chunked narration + (optional) subtitle burn-in, then concat all scenes
 * into renders/final.mp4.
 *
 * Errors include a `hint` field for known patterns (missing drawtext, no
 * recording, etc.) so the UI can render actionable messages.
 */
export async function renderFinalVideo(
  projectPath: string,
  opts: RenderOptions = {},
  onProgress?: RenderProgress,
): Promise<RenderResult> {
  let sb = await loadStoryboard(projectPath);
  if (!sb) throw new RenderError('No storyboard found', { hint: 'Build the storyboard first' });

  const audioMode = opts.audioMode ?? 'replace';
  const burnSubtitles = opts.burnSubtitles ?? false;

  const renderableScenes = sb.scenes.filter((s) => s.recording?.source);
  if (renderableScenes.length === 0) {
    throw new RenderError('No scenes have a recording yet', {
      hint: 'Upload at least one scene recording before rendering',
    });
  }

  // Pre-load the frame manifest once so each scene's frame pass doesn't pay
  // the JSON-parse cost. Skipped entirely when no scene uses a frame — the
  // helper bails out before touching the manifest in that case, but loading
  // it up-front avoids a stat/parse on every iteration when frames ARE used.
  const framesRequested = renderableScenes.some(
    (s) => s.frame_style ?? sb!.defaults?.frame_style,
  );
  const frameDeps: FramePrepDeps = opts.__frameDeps ?? {};
  if (framesRequested && !frameDeps.manifest) {
    const assetsDir = frameDeps.assetsDir ?? defaultAssetsDir();
    frameDeps.manifest = await loadFrameManifest(assetsDir);
    frameDeps.assetsDir = assetsDir;
  }

  const rendersDir = join(projectPath, 'renders');
  const tmpDir = join(rendersDir, '.tmp');
  await mkdir(rendersDir, { recursive: true });
  await mkdir(tmpDir, { recursive: true });

  const scenePaths: string[] = [];
  for (let i = 0; i < renderableScenes.length; i++) {
    // Refresh scene reference from the (possibly updated) storyboard so the
    // frame_render path persisted on a prior iteration is visible here.
    const scene = sb.scenes.find((s) => s.id === renderableScenes[i]!.id)!;
    onProgress?.({
      type: 'step',
      step: 'concat-audio',
      sceneIndex: i,
      sceneId: scene.id,
      totalScenes: renderableScenes.length,
      message: `Preparing audio for scene ${i + 1}/${renderableScenes.length}`,
    });

    const sceneAudioPath = await prepareSceneAudio(projectPath, scene, tmpDir);

    onProgress?.({
      type: 'step',
      step: 'mux-scene',
      sceneIndex: i,
      sceneId: scene.id,
      totalScenes: renderableScenes.length,
      message: `Rendering scene ${i + 1}/${renderableScenes.length} (${scene.name})`,
    });

    const sceneMp4 = join(rendersDir, `${paddedIndex(i)}-${slug(scene.name)}.mp4`);
    const muxResult = await muxScene({
      projectPath,
      storyboard: sb,
      scene,
      defaults: sb.defaults,
      audioPath: sceneAudioPath,
      audioMode,
      burnSubtitles,
      outputPath: sceneMp4,
      vpaHome: opts.vpaHome ?? '',
      workspaceRoot: opts.workspaceRoot ?? '',
      frameDeps,
    });
    // Persist any frame_render path written during the mux.
    if (muxResult.storyboard !== sb) {
      sb = muxResult.storyboard;
      await saveStoryboard(projectPath, sb);
    }
    scenePaths.push(sceneMp4);
  }

  onProgress?.({
    type: 'step',
    step: 'concat-scenes',
    totalScenes: renderableScenes.length,
    message: `Joining ${renderableScenes.length} scene(s) into final.mp4`,
  });

  const finalPath = join(rendersDir, 'final.mp4');
  // If we're going to overlay music, write the concat result to a temp file
  // first so we can run a 2-input ffmpeg pass into the real final.mp4.
  const concatOutPath = opts.music ? join(tmpDir, 'concat.mp4') : finalPath;
  await concatScenes(scenePaths, concatOutPath, tmpDir);

  // Stage 4: optional background music overlay
  if (opts.music) {
    onProgress?.({
      type: 'step',
      step: 'mix-music',
      totalScenes: renderableScenes.length,
      message: `Mixing background music (${opts.music.volumeDb ?? -20} dB)`,
    });
    await overlayMusic({
      videoPath: concatOutPath,
      musicPath: opts.music.audioPath,
      volumeDb: opts.music.volumeDb ?? -20,
      outputPath: finalPath,
    });
  }

  const durationSec = await probeDuration(finalPath);

  // Clean up tmp dir but keep per-scene mp4s for debugging / re-runs
  await rm(tmpDir, { recursive: true, force: true });

  onProgress?.({
    type: 'step',
    step: 'done',
    totalScenes: renderableScenes.length,
    message: `Done — final.mp4 (${durationSec.toFixed(1)}s)`,
  });

  return { outputPath: finalPath, scenePaths, durationSec };
}

// ── Stage 4: music overlay ──────────────────────────────────────────

interface MusicOverlayOpts {
  videoPath: string;        // input video (post scene-concat)
  musicPath: string;        // background music track (mp3/wav)
  volumeDb: number;         // negative dB to duck music under narration
  outputPath: string;       // final.mp4
}

/**
 * Overlay background music under the existing audio of `videoPath`. Music
 * is loop-extended with `-stream_loop -1` and trimmed to the video duration
 * via amix's `duration=first`. Existing narration sits on top at full volume.
 *
 * Filter chain:
 *   [1:a] aloop -> volume=Xdb -> afade out at end -> [music]
 *   [0:a][music] amix=duration=first:dropout_transition=2 -> [aout]
 *   then map [aout] + the original [0:v]
 */
async function overlayMusic(opts: MusicOverlayOpts): Promise<void> {
  const dur = await probeDuration(opts.videoPath);
  // 1.5s tail fade keeps the music from cutting off abruptly.
  const fadeOutStart = Math.max(0, dur - 1.5);

  const filterComplex = [
    `[1:a]aloop=loop=-1:size=2147483647,volume=${opts.volumeDb}dB,afade=t=out:st=${fadeOutStart.toFixed(3)}:d=1.5[music]`,
    `[0:a][music]amix=inputs=2:duration=first:dropout_transition=2[aout]`,
  ].join(';');

  await runFfmpeg([
    '-y',
    '-i', opts.videoPath,
    '-i', opts.musicPath,
    '-filter_complex', filterComplex,
    '-map', '0:v:0',
    '-map', '[aout]',
    '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', '192k',
    '-shortest',
    opts.outputPath,
  ]);
}

// ── Stage 1: audio prep ──────────────────────────────────────────────

/**
 * Returns the path to the scene's narration audio. Either:
 *   - The legacy single-track narration.audio if present, or
 *   - A concatenated tmp file built from narration.chunks[*].audio
 *   - null if no narration exists (caller will mux video without audio override)
 */
async function prepareSceneAudio(projectPath: string, scene: Scene, tmpDir: string): Promise<string | null> {
  const narration = scene.narration;
  if (!narration) return null;

  if (narration.audio) {
    const full = join(projectPath, narration.audio);
    if (existsSync(full)) return full;
  }

  const chunks = (narration.chunks ?? []).filter((c) => c.audio);
  if (chunks.length === 0) return null;

  if (chunks.length === 1) {
    const full = join(projectPath, chunks[0]!.audio!);
    return existsSync(full) ? full : null;
  }

  // Concat multiple chunks via ffmpeg concat demuxer (works without re-encode for
  // matching codecs, which our chunks are since they come from the same TTS).
  const sortedChunks = [...chunks].sort((a, b) => a.index - b.index);
  const concatList = join(tmpDir, `${scene.id}-audio-list.txt`);
  const lines = sortedChunks.map((c) => {
    const abs = join(projectPath, c.audio!);
    // ffmpeg concat list format: file 'PATH' — escape single quotes by closing then re-opening
    return `file '${abs.replace(/'/g, "'\\''")}'`;
  }).join('\n');
  await writeFile(concatList, lines);

  const out = join(tmpDir, `${scene.id}-audio.mp3`);
  await runFfmpeg([
    '-y', '-f', 'concat', '-safe', '0', '-i', concatList,
    '-c:a', 'libmp3lame', '-b:a', '192k',
    out,
  ]);
  return out;
}

// ── Frame compositing (slots between LT-overlay and audio mux) ───────

/**
 * Internal DI seams for the frame pass. Tests pass fakes; production callers
 * leave them undefined to get the real ffmpeg-backed implementations.
 */
export interface FramePrepDeps {
  manifest?: FrameManifest;
  frameRenderer?: FrameRenderer;
  brandColorResolver?: BrandColorResolver;
  assetsDir?: string;
}

interface PrepareSceneFrameOpts {
  projectPath: string;
  /** Storyboard handle — used to persist `scene.frame_render` after a fresh render. */
  storyboard: Storyboard;
  scene: Scene;
  defaults: StoryboardDefaults | undefined;
  /** Absolute path to the upstream video (overlay_render or raw recording). */
  upstreamVideo: string;
  vpaHome: string;
  workspaceRoot: string;
  deps: FramePrepDeps;
}

interface PrepareSceneFrameResult {
  /** Absolute path to the framed video that should feed the audio mux. */
  framedVideo: string;
  /** Updated storyboard (if `scene.frame_render` was written). Caller owns persisting it. */
  updatedStoryboard: Storyboard;
  /** Whether the frame pass ran (false = cache hit or no frame requested). */
  rendered: boolean;
}

/**
 * If the scene (or storyboard defaults) requests a device frame, composite the
 * upstream video into it and cache the result at
 *   `renders/.frame/<sceneId>-framed.mp4`
 * relative to the project. Returns the framed video path so callers can feed it
 * into the audio mux stage.
 *
 * Returns `null` when no frame is requested — callers should fall through to
 * their existing video-source resolution (overlay_render, else recording).
 *
 * Cache invalidation: if the cached file exists and its mtime is at least as
 * recent as the upstream video's mtime, the ffmpeg pass is skipped. The path
 * is also persisted to `scene.frame_render` in the (returned) storyboard.
 */
export async function prepareSceneFrame(
  opts: PrepareSceneFrameOpts,
): Promise<PrepareSceneFrameResult | null> {
  const {
    projectPath,
    storyboard,
    scene,
    defaults,
    upstreamVideo,
    vpaHome,
    workspaceRoot,
    deps,
  } = opts;

  // Manifest is shared per-project-render; load lazily if the caller didn't
  // pre-load. defaultAssetsDir() points at the bundled assets folder.
  const assetsDir = deps.assetsDir ?? defaultAssetsDir();
  const manifest = deps.manifest ?? (await loadFrameManifest(assetsDir));

  const resolved = await resolveSceneFrame({
    scene,
    defaults,
    manifest,
    assetsDir,
    projectPath,
    vpaHome,
    workspaceRoot,
    brandColorResolver: deps.brandColorResolver,
  });
  if (!resolved) return null;

  // Cache location is deterministic per scene id so re-runs reuse the same
  // file. Hidden `.frame` subdir keeps renders/ tidy alongside .tmp.
  const cacheRel = join('renders', '.frame', `${scene.id}-framed.mp4`);
  const cacheAbs = join(projectPath, cacheRel);

  const cacheFresh = await isCacheFresh(cacheAbs, upstreamVideo);
  let updatedStoryboard = storyboard;

  if (cacheFresh) {
    // Persist cache path in case it wasn't set (e.g. someone hand-copied the
    // file). Idempotent — does nothing if already equal.
    if (scene.frame_render !== cacheRel) {
      updatedStoryboard = updateScene(storyboard, scene.id, { frame_render: cacheRel });
    }
    return { framedVideo: cacheAbs, updatedStoryboard, rendered: false };
  }

  await mkdir(dirname(cacheAbs), { recursive: true });

  const renderer = deps.frameRenderer ?? createFrameRenderer();
  await renderer({
    inputVideo: upstreamVideo,
    frameEntry: resolved.frameEntry,
    assetsDir: resolved.assetsDir,
    backgroundColor: resolved.backgroundColor,
    outputPath: cacheAbs,
  });

  updatedStoryboard = updateScene(storyboard, scene.id, { frame_render: cacheRel });
  return { framedVideo: cacheAbs, updatedStoryboard, rendered: true };
}

/**
 * Returns true when `cachePath` exists and its mtime is >= `upstreamPath`'s
 * mtime — i.e. the framed video is at least as new as its input. False on any
 * stat error (missing files, permission issues), so the caller will re-render.
 */
async function isCacheFresh(cachePath: string, upstreamPath: string): Promise<boolean> {
  try {
    const [cacheStat, upstreamStat] = await Promise.all([stat(cachePath), stat(upstreamPath)]);
    return cacheStat.mtimeMs >= upstreamStat.mtimeMs;
  } catch {
    return false;
  }
}

// ── Stage 2: per-scene mux ───────────────────────────────────────────

interface MuxOpts {
  projectPath: string;
  storyboard: Storyboard;
  scene: Scene;
  defaults: StoryboardDefaults | undefined;
  audioPath: string | null;
  audioMode: 'replace' | 'mix';
  burnSubtitles: boolean;
  outputPath: string;
  vpaHome: string;
  workspaceRoot: string;
  frameDeps: FramePrepDeps;
}

interface MuxResult {
  /** Storyboard reflecting any `frame_render` writes from the frame pass.
   *  Equal-by-reference to `opts.storyboard` when nothing changed. */
  storyboard: Storyboard;
}

async function muxScene(opts: MuxOpts): Promise<MuxResult> {
  const {
    projectPath,
    storyboard,
    scene,
    defaults,
    audioPath,
    audioMode,
    burnSubtitles,
    outputPath,
    vpaHome,
    workspaceRoot,
    frameDeps,
  } = opts;

  // Use the rendered overlay video (with lower thirds) if available;
  // otherwise the raw recording.
  const overlay = scene.overlay_render ? join(projectPath, scene.overlay_render) : null;
  const rec = scene.recording!.source;
  const recPath = join(projectPath, rec);
  const upstreamVideo = overlay && existsSync(overlay) ? overlay : recPath;

  // Frame pass — slot between lower-thirds bake and audio mux. When no frame
  // is requested, this returns null and we fall through to the upstream video.
  const framePrep = await prepareSceneFrame({
    projectPath,
    storyboard,
    scene,
    defaults,
    upstreamVideo,
    vpaHome,
    workspaceRoot,
    deps: frameDeps,
  });
  const videoSrc = framePrep?.framedVideo ?? upstreamVideo;
  const updatedStoryboard = framePrep?.updatedStoryboard ?? storyboard;

  const args: string[] = ['-y', '-i', videoSrc];
  if (audioPath) args.push('-i', audioPath);

  // Optional subtitle burn-in
  if (burnSubtitles && scene.narration?.subtitles?.srt) {
    const srt = join(projectPath, scene.narration.subtitles.srt);
    if (existsSync(srt)) {
      args.push('-vf', `subtitles=${escapeForFilter(srt)}`);
    }
  }

  // Audio routing
  if (audioPath) {
    if (audioMode === 'replace') {
      // Drop original audio, use only narration. Map the narration audio
      // and trim/pad it to the video's length so duration matches.
      args.push('-map', '0:v:0', '-map', '1:a:0');
      args.push('-c:v', burnSubtitles ? 'libx264' : 'copy');  // re-encode if filtering
      args.push('-c:a', 'aac', '-b:a', '192k');
      args.push('-shortest');
    } else {
      // Mix narration over original audio (narration full volume, recording -20dB)
      args.push('-filter_complex', '[0:a]volume=0.1[a0];[1:a]volume=1.0[a1];[a0][a1]amix=inputs=2:duration=longest[aout]');
      args.push('-map', '0:v:0', '-map', '[aout]');
      args.push('-c:v', burnSubtitles ? 'libx264' : 'copy');
      args.push('-c:a', 'aac', '-b:a', '192k');
    }
  } else {
    // No narration — just remux the video
    args.push('-c', 'copy');
  }

  args.push(outputPath);
  await runFfmpeg(args);

  return { storyboard: updatedStoryboard };
}

// ── Stage 3: multi-scene concat ──────────────────────────────────────

async function concatScenes(scenePaths: string[], outputPath: string, tmpDir: string): Promise<void> {
  if (scenePaths.length === 1) {
    // Single-scene "concat" is just a copy — but use ffmpeg to re-mux into final.mp4
    // so the output filename and structure is consistent.
    await runFfmpeg(['-y', '-i', scenePaths[0]!, '-c', 'copy', outputPath]);
    return;
  }

  const concatList = join(tmpDir, 'scenes-list.txt');
  const lines = scenePaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
  await writeFile(concatList, lines);

  // The concat demuxer requires matching codecs. Our scenes use h264 + AAC after
  // muxScene runs, so `-c copy` works in the common case.
  // Fallback: if -c copy fails (mismatched codecs/dimensions), retry with re-encode.
  try {
    await runFfmpeg([
      '-y', '-f', 'concat', '-safe', '0', '-i', concatList,
      '-c', 'copy', outputPath,
    ]);
  } catch (err) {
    if (err instanceof RenderError && /Non-monotonous|invalid|codec|negative/i.test(err.message)) {
      // Re-encode pass — slower but tolerates any mix
      await runFfmpeg([
        '-y', '-f', 'concat', '-safe', '0', '-i', concatList,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
        '-c:a', 'aac', '-b:a', '192k',
        outputPath,
      ]);
    } else {
      throw err;
    }
  }
}

// ── ffmpeg helpers ───────────────────────────────────────────────────

/** Re-exported for the per-scene render service so we don't duplicate the
 *  ffmpeg invocation + RenderError mapping. */
export async function runFfmpeg(args: string[]): Promise<void> {
  try {
    await execFileAsync('ffmpeg', args, {
      timeout: 600_000, // 10 minute cap per ffmpeg call
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? '';
    const message = (err as Error).message ?? String(err);
    throw new RenderError(message, {
      stderrTail: stderr.slice(-2000),
      hint: hintFromStderr(stderr),
    });
  }
}

export async function probeDuration(path: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      path,
    ], { timeout: 30_000 });
    return Number.parseFloat(stdout.trim()) || 0;
  } catch {
    return 0;
  }
}

/** Map known ffmpeg stderr patterns to a human-readable fix hint. */
function hintFromStderr(stderr: string): string | undefined {
  if (/No such filter:\s*'?drawtext'?/i.test(stderr)) {
    return 'ffmpeg lacks freetype — see /setup, then reinstall via homebrew-ffmpeg/ffmpeg/ffmpeg';
  }
  if (/No such filter:\s*'?subtitles'?/i.test(stderr)) {
    return 'ffmpeg lacks libass — disable subtitle burn-in or rebuild ffmpeg with --enable-libass';
  }
  if (/Invalid data found when processing input/i.test(stderr)) {
    return 'A scene recording or audio file is malformed — re-encode the source';
  }
  if (/Non-monotonous DTS|negative.*pts/i.test(stderr)) {
    return 'Scenes have inconsistent timestamps — concat will retry with re-encode';
  }
  return undefined;
}

/** Escape a path for use inside a `-vf` filter argument. */
export function escapeForFilter(p: string): string {
  // colon must be escaped, backslashes too
  return p
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'");
}

function paddedIndex(i: number): string {
  return `scene-${String(i + 1).padStart(2, '0')}`;
}

function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'scene';
}

export class RenderError extends Error {
  hint?: string;
  stderrTail?: string;
  constructor(message: string, opts: { hint?: string; stderrTail?: string } = {}) {
    super(message);
    this.name = 'RenderError';
    this.hint = opts.hint;
    this.stderrTail = opts.stderrTail;
  }
}
