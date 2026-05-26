import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rm, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadStoryboard, saveStoryboard, updateScene } from '../storyboard/index.js';
import type { Scene, SceneTransition, Storyboard, StoryboardDefaults } from '@vpa/shared';
import {
  loadFrameManifest,
  defaultAssetsDir,
  type FrameManifest,
} from '../frame/manifest.js';
import { createFrameRenderer, type FrameRenderer } from '../frame/render.js';
import {
  resolveSceneFrame,
  createCachingBrandColorResolver,
  defaultBrandColorResolver,
  type BrandColorResolver,
} from '../frame/resolve.js';
import { renderLowerThirdsOverlay } from '../overlay/render.js';
import { resolveLtColors } from '../overlay/colors.js';
import { buildTransitionClip } from './transition-clip.js';

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
   * When false, ignores any narration the scenes might have and renders with
   * the recording's original audio (or no audio if the recording is silent).
   * Useful when the user only narrated a subset of scenes and would rather
   * ship the original audio across the board.
   *
   * Default: true (existing behaviour — narration is used when present).
   */
  includeNarration?: boolean;
  /**
   * When false, ignores the burned lower-thirds overlay even if it exists on
   * disk and renders the raw recording instead. Lets the user keep edited
   * lower-thirds in the project without forcing them into the final video.
   *
   * Default: true (existing behaviour — overlay used when present).
   */
  includeLowerThirds?: boolean;
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
   * Optional brand bumper videos. Prepended / appended to the scene chain at
   * concat time so the final video opens with `bumperIntro` and ends with
   * `bumperOutro`. Either may be omitted; both bypass when not set. Absolute
   * paths — the caller (render route) resolves the brand's asset path.
   *
   * Bumpers go through the same xfade/concat normalisation as regular scenes,
   * so size mismatches with the rest of the project are handled.
   */
  bumperIntro?: string;
  bumperOutro?: string;
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
  const includeNarration = opts.includeNarration ?? true;
  const includeLowerThirds = opts.includeLowerThirds ?? true;

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
  // Wrap the brand resolver in a per-render memo so design.md is read once even
  // when multiple scenes all use frame_background: 'brand'.
  frameDeps.brandColorResolver = createCachingBrandColorResolver(
    frameDeps.brandColorResolver ?? defaultBrandColorResolver,
  );

  const rendersDir = join(projectPath, 'renders');
  const tmpDir = join(rendersDir, '.tmp');
  await mkdir(rendersDir, { recursive: true });
  await mkdir(tmpDir, { recursive: true });

  // Resolve lower-thirds colour palette once per render. Only needed when at
  // least one scene actually has LTs AND the user wants them included; we lazy-
  // init in the loop below to avoid the brand-resolution work otherwise.
  let ltColors: Awaited<ReturnType<typeof resolveLtColors>> | null = null;

  const scenePaths: string[] = [];
  for (let i = 0; i < renderableScenes.length; i++) {
    // Refresh scene reference from the (possibly updated) storyboard so the
    // frame_render path persisted on a prior iteration is visible here.
    let scene = sb.scenes.find((s) => s.id === renderableScenes[i]!.id)!;
    onProgress?.({
      type: 'step',
      step: 'concat-audio',
      sceneIndex: i,
      sceneId: scene.id,
      totalScenes: renderableScenes.length,
      message: `Preparing audio for scene ${i + 1}/${renderableScenes.length}`,
    });

    // Skip narration entirely when the user opted out at render time. Falls
    // through to the no-audio-override branch in muxScene (uses original
    // recording audio).
    const sceneAudioPath = includeNarration
      ? await prepareSceneAudio(projectPath, scene, tmpDir)
      : null;

    // Bake lower-thirds into a per-scene overlay file ON DEMAND. Previously
    // the project-level render assumed `scene.overlay_render` was already set
    // by a prior per-scene render, but most users only ever hit the project
    // "Render full project" button — so LTs they added in the UI silently got
    // dropped at render time. Now we run the same bake step the per-scene
    // render uses, gated on `includeLowerThirds` and on actual LT data.
    if (includeLowerThirds && (scene.lower_thirds?.length ?? 0) > 0) {
      const overlayPath = scene.overlay_render
        ? join(projectPath, scene.overlay_render)
        : null;
      if (!overlayPath || !existsSync(overlayPath)) {
        if (!ltColors) {
          ltColors = await resolveLtColors(projectPath, {
            vpaHome: opts.vpaHome ?? '',
            workspaceRoot: opts.workspaceRoot ?? '',
          });
        }
        const baked = await renderLowerThirdsOverlay({
          projectPath,
          sceneId: scene.id,
          recordingPath: join(projectPath, scene.recording!.source),
          lowerThirds: scene.lower_thirds!,
          colors: ltColors,
        });
        sb = updateScene(sb, scene.id, { overlay_render: baked.outputPath });
        await saveStoryboard(projectPath, sb);
        scene = sb.scenes.find((s) => s.id === renderableScenes[i]!.id)!;
      }
    }

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
      includeLowerThirds,
    });
    // Save per-scene so a crash mid-loop leaves the cached frame_render
    // paths persisted — the next render skips work already done.
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

  // Build the join plan: each entry is the rendered scene mp4 + the transition
  // that should play at its OUT-edge. The final scene's transition is ignored
  // (nothing to transition into) — concatScenes handles that.
  const joinPlan: JoinEntry[] = renderableScenes.map((rs, i) => {
    const scene = sb.scenes.find((s) => s.id === rs.id)!;
    return {
      path: scenePaths[i]!,
      transition: scene.transition,
      durationSec: scene.transition_duration_sec ?? 0.5,
      kind: 'scene',
      // Tag with the scene id so the inserted transition clip's tmp file
      // name is deterministic (lets future caching key on these).
      sceneId: rs.id,
    };
  });

  // Prepend / append brand bumpers if the caller supplied them. Bumpers come
  // from the project's brand (resolved by the render route) — they're optional
  // and arbitrary in shape, so we normalise each one to match the rest of the
  // chain (dimensions, fps, audio profile) before concat. The normalised
  // copies live in tmpDir alongside everything else and get cleaned up at end
  // of the function. Cuts (transition: undefined) between bumpers and scenes
  // are intentional — bumpers come in/out cleanly, no fancy xfade.
  if (opts.bumperIntro || opts.bumperOutro) {
    const firstSize = await probeVideoSize(scenePaths[0]!);
    const targetW = firstSize.width || 1920;
    const targetH = firstSize.height || 1080;
    if (opts.bumperIntro && existsSync(opts.bumperIntro)) {
      const normalised = await normaliseBumper(
        opts.bumperIntro, targetW, targetH, includeNarration, tmpDir, 'intro',
      );
      joinPlan.unshift({ path: normalised, durationSec: 0.5, kind: 'bumper' });
    }
    if (opts.bumperOutro && existsSync(opts.bumperOutro)) {
      const normalised = await normaliseBumper(
        opts.bumperOutro, targetW, targetH, includeNarration, tmpDir, 'outro',
      );
      joinPlan.push({ path: normalised, durationSec: 0.5, kind: 'bumper' });
    }
  }

  // When narration is excluded, the per-scene mp4s have no audio track (see
  // muxScene's `-an` branch). Tell concatScenes so its filter graph requests
  // a=0 instead of a=1 — otherwise ffmpeg errors out trying to read audio
  // streams that don't exist.
  await concatScenes(joinPlan, concatOutPath, tmpDir, { hasAudio: includeNarration });

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
 * Cache invalidation: if the cached file exists and its mtime is strictly
 * newer than the upstream video's mtime, the ffmpeg pass is skipped. The path
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
 * Returns true when `cachePath` exists and its mtime is strictly > `upstreamPath`'s
 * mtime — i.e. the framed video was modified AFTER its input. False on any
 * stat error (missing files, permission issues), so the caller will re-render.
 *
 * Tied mtimes (same-second writes on low-resolution filesystems) are NOT
 * considered fresh so a simultaneous upstream write always forces a re-render.
 */
async function isCacheFresh(cachePath: string, upstreamPath: string): Promise<boolean> {
  try {
    const [cacheStat, upstreamStat] = await Promise.all([stat(cachePath), stat(upstreamPath)]);
    return cacheStat.mtimeMs > upstreamStat.mtimeMs;
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
  /** When false, ignore the lower-thirds overlay even if `scene.overlay_render`
   *  points at a baked file. Allows the user to keep edited lower-thirds in
   *  the project but ship the final video without them. */
  includeLowerThirds?: boolean;
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
    includeLowerThirds = true,
  } = opts;

  // Use the rendered overlay video (with lower thirds) if available AND the
  // caller wants lower-thirds in this render; otherwise fall back to the raw
  // recording. The `includeLowerThirds=false` flag lets the user opt out at
  // render time without losing their edited lower-thirds data.
  const overlay = includeLowerThirds && scene.overlay_render
    ? join(projectPath, scene.overlay_render)
    : null;
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

  // Detect narration overrun — TTS audio is often a fraction of a second
  // longer than the recording, especially on the last paragraph. With the
  // old `-shortest` pattern, that tail got clipped mid-word (a real bug
  // report: scene-02's "[excited] Now, you have a solid foundation…" cut
  // at "have"). Fix: pad the video by holding the last frame for the
  // overrun so audio plays through cleanly.
  let videoPadSec = 0;
  if (audioPath) {
    const [vDur, aDur] = await Promise.all([
      probeDuration(videoSrc),
      probeDuration(audioPath),
    ]);
    const overrun = aDur - vDur;
    // 50 ms threshold — ignore sub-frame fudge from probe rounding.
    if (overrun > 0.05) videoPadSec = overrun;
  }

  // Build the video filter chain. tpad + subtitles compose into one
  // -filter_complex when either is needed; otherwise we keep -c copy on
  // the video for the fast path.
  const vFilters: string[] = [];
  if (burnSubtitles && scene.narration?.subtitles?.srt) {
    const srt = join(projectPath, scene.narration.subtitles.srt);
    if (existsSync(srt)) {
      vFilters.push(`subtitles=${escapeForFilter(srt)}`);
    }
  }
  if (videoPadSec > 0) {
    // stop_mode=clone holds the last decoded frame for stop_duration
    // seconds. Must run AFTER subtitles so the pad shows whatever the
    // last burnt-in subtitle was (subs are typically gone by then).
    vFilters.push(`tpad=stop_mode=clone:stop_duration=${videoPadSec.toFixed(3)}`);
  }
  const needsVideoReencode = vFilters.length > 0;

  if (needsVideoReencode) {
    args.push('-filter_complex', `[0:v]${vFilters.join(',')}[v]`);
  }

  // Audio routing
  if (audioPath) {
    if (audioMode === 'replace') {
      // Drop original audio, use only narration.
      args.push('-map', needsVideoReencode ? '[v]' : '0:v:0', '-map', '1:a:0');
      args.push('-c:v', needsVideoReencode ? 'libx264' : 'copy');
      args.push('-c:a', 'aac', '-b:a', '192k');
      // We deliberately do NOT pass `-shortest` here. When videoPadSec > 0
      // the freeze-pad extends video to match audio so both streams end
      // together. When videoPadSec === 0 audio is already ≤ video — the
      // container will just stop at the natural end of the shorter stream
      // without trimming the longer one.
    } else {
      // Mix narration over original audio (narration full volume, recording -20dB)
      const audioFilter = '[0:a]volume=0.1[a0];[1:a]volume=1.0[a1];[a0][a1]amix=inputs=2:duration=longest[aout]';
      const filterComplex = needsVideoReencode
        ? `[0:v]${vFilters.join(',')}[v];${audioFilter}`
        : audioFilter;
      args.push('-filter_complex', filterComplex);
      args.push('-map', needsVideoReencode ? '[v]' : '0:v:0', '-map', '[aout]');
      args.push('-c:v', needsVideoReencode ? 'libx264' : 'copy');
      args.push('-c:a', 'aac', '-b:a', '192k');
    }
  } else {
    // No narration audio for this scene → render with NO audio track. We
    // previously did `-c copy` which preserved the recording's original audio
    // (screen-recording system sounds, mouse clicks, etc.) — surprising users
    // who unchecked "Include narration" expecting silence. Audio from the
    // source recording is dropped via `-an`; video copies as before.
    args.push(
      '-map', needsVideoReencode ? '[v]' : '0:v:0',
      '-c:v', needsVideoReencode ? 'libx264' : 'copy', '-an',
    );
  }

  args.push(outputPath);
  await runFfmpeg(args);

  return { storyboard: updatedStoryboard };
}

// ── Stage 3: multi-scene concat ──────────────────────────────────────

interface JoinEntry {
  path: string;
  /** Transition at the OUT-edge of this scene (ignored on the last entry,
   *  and ignored when the next entry is a bumper — bumpers always come in
   *  on a hard cut). */
  transition?: SceneTransition;
  /** Transition duration in seconds — i.e. the length of the inserted
   *  freeze-frame transition clip. */
  durationSec: number;
  /** Tells the expansion step whether a transition clip is allowed at the
   *  OUT-edge. Bumpers never get one. Defaults to 'scene' on caller side. */
  kind?: 'scene' | 'bumper';
  /** Scene id when kind === 'scene'. Used to name the transition clip in
   *  the tmp dir so concurrent builds don't collide. */
  sceneId?: string;
}

/**
 * Map our user-facing transition labels to ffmpeg `xfade` filter names. Ported
 * from the tanzu-video-pipeline project's xfade mapping. Audio is crossfaded
 * with `acrossfade` over the same duration.
 *
 * Keep `cut` out of this map — `cut` triggers the concat-demuxer fast path
 * with no xfade pass.
 */
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

interface ConcatOpts {
  /** Set true when the per-scene mp4s have an audio stream. When false, the
   *  filter graphs request a=0 / drop audio mapping. */
  hasAudio: boolean;
}

async function concatScenes(scenes: JoinEntry[], outputPath: string, tmpDir: string, opts: ConcatOpts = { hasAudio: true }): Promise<void> {
  if (scenes.length === 1) {
    await runFfmpeg(['-y', '-i', scenes[0]!.path, '-c', 'copy', outputPath]);
    return;
  }

  // Expand non-cut transitions into inserted freeze-frame transition clips.
  // Each transition clip = last frame of A + first frame of B + xfade across
  // the full duration. The source scenes themselves play in full and are
  // joined to the transition clip with hard cuts. See transition-clip.ts for
  // the full rationale (TL;DR: ffmpeg `xfade` directly between scene mp4s
  // eats the last N seconds of A and first N seconds of B, which kills the
  // narration tail / next-scene opening on a demo video).
  //
  // Bumpers (kind: 'bumper') deliberately stay as hard cuts — the user
  // wants the intro/outro to come in / out cleanly with no transition
  // dress-up.
  const expanded: JoinEntry[] = [];
  for (let i = 0; i < scenes.length; i++) {
    const cur = scenes[i]!;
    // Drop the transition off the original entry — every join in the
    // expanded plan is a hard cut now.
    expanded.push({ ...cur, transition: undefined });
    const next = scenes[i + 1];
    const shouldInsert =
      next &&
      cur.transition &&
      cur.transition !== 'cut' &&
      cur.kind !== 'bumper' &&
      next.kind !== 'bumper' &&
      cur.durationSec > 0;
    if (next && shouldInsert) {
      const transClipPath = join(tmpDir, `transition-${cur.sceneId ?? i}.mp4`);
      // Probe the FROM scene for both video size and audio params. The
      // transition clip MUST match both — mismatched audio sample rate or
      // channel count silently corrupts the concat-demuxer output (the
      // player sees 0:0.0 even though ffprobe says the file is fine).
      const [size, audio] = await Promise.all([
        probeVideoSize(cur.path),
        opts.hasAudio ? probeAudioParams(cur.path) : Promise.resolve({ sampleRate: 0, channels: 0, channelLayout: '' }),
      ]);
      const w = size.width || 1920;
      const h = size.height || 1080;
      await buildTransitionClip({
        fromScenePath: cur.path,
        toScenePath: next.path,
        transition: cur.transition as Exclude<SceneTransition, 'cut'>,
        durationSec: cur.durationSec,
        width: w,
        height: h,
        hasAudio: opts.hasAudio,
        audioSampleRate: audio.sampleRate || 44100,
        audioChannelLayout: audio.channelLayout || (audio.channels === 1 ? 'mono' : 'stereo'),
        outputPath: transClipPath,
        tmpDir,
        cacheTag: cur.sceneId ?? `i${i}`,
      });
      expanded.push({
        path: transClipPath,
        durationSec: 0,
        kind: 'scene',
      });
    }
  }
  scenes = expanded;

  // After expansion every join is a cut → fast path. The slow-path xfade
  // chain below is dead code for the user-driven render flow; kept for
  // safety if a future caller passes a joinPlan with raw transitions in.
  const hasTransitions = scenes.slice(0, -1).some(
    (s) => s.transition && s.transition !== 'cut',
  );
  if (!hasTransitions) {
    return concatScenesPlain(scenes.map((s) => s.path), outputPath, tmpDir, opts);
  }

  // Slow path: build a chained xfade + acrossfade filter graph. Each transition
  // overlaps `durationSec` seconds of two scenes, so we need every scene's
  // duration upfront to compute correct xfade `offset` values.
  const [durations, sizes] = await Promise.all([
    Promise.all(scenes.map((s) => probeDuration(s.path))),
    Promise.all(scenes.map((s) => probeVideoSize(s.path))),
  ]);

  // xfade requires identical width × height on both sides. Real recordings
  // often differ by a couple of pixels (frame baking, codec quirks). Pick a
  // single target — the first scene's size — and prepend a scale+pad filter
  // to every input that normalises to that target. We also force SAR=1:1 so
  // xfade can't trip on display-aspect-ratio mismatches.
  const targetW = sizes[0]?.width || 1920;
  const targetH = sizes[0]?.height || 1080;
  // Even dimensions are required by libx264 (yuv420p chroma subsampling).
  const normW = targetW + (targetW % 2);
  const normH = targetH + (targetH % 2);

  const inputArgs: string[] = [];
  for (const s of scenes) {
    inputArgs.push('-i', s.path);
  }

  const videoFilters: string[] = [];
  const audioFilters: string[] = [];

  // Per-input normalisation filters — every scene goes through scale + pad
  // (preserving aspect) so the xfade chain sees matching dimensions. We label
  // the outputs [n0],[n1],... and reference those instead of [0:v],[1:v].
  //
  // `settb=1/90000` forces a uniform timebase across every input. Without it,
  // xfade errors out with "main timebase do not match xfade timebase" when
  // some inputs come from different sources — e.g. recorded scenes (1/1000000)
  // mixed with normalised bumpers (1/15360). 90000 is the standard mpeg
  // timebase and divides evenly for 30/60fps content. `fps=60` is included so
  // every input also has a uniform frame rate; xfade's offset math relies on
  // PTS being consistent across both inputs.
  for (let i = 0; i < scenes.length; i++) {
    videoFilters.push(
      `[${i}:v]scale=${normW}:${normH}:force_original_aspect_ratio=decrease,` +
      `pad=${normW}:${normH}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=60,settb=1/90000[n${i}]`,
    );
  }

  let vTag = '[n0]';
  let aTag = '[0:a]';
  // Time position (in the output) of the END of the latest concatenated chunk.
  // For the first scene this is its full duration; for each subsequent xfade
  // it advances by next.duration - transition.durationSec (the overlap).
  let runningEndSec = durations[0]!;

  for (let i = 0; i < scenes.length - 1; i++) {
    const outV = `[v${i + 1}]`;
    const outA = `[a${i + 1}]`;
    const trans = scenes[i]!.transition;
    const dur = scenes[i]!.durationSec;
    const nextDur = durations[i + 1]!;
    const nextV = `[n${i + 1}]`;

    // Both `concat` and `xfade` filters set their own output timebase, which
    // tends to default to 1/AV_TIME_BASE (1/1000000). The NEXT filter in the
    // chain then sees a timebase mismatch against the still-1/90000-tagged
    // [n_i+1] input and errors with "main timebase do not match xfade
    // timebase". Forcing `settb=1/90000` on every intermediate output keeps
    // the whole chain on one timebase.
    if (trans && trans !== 'cut') {
      const xfadeName = XFADE_FILTER_MAP[trans as Exclude<SceneTransition, 'cut'>];
      // xfade offset = start time of the overlap in the OUTPUT so far.
      const offset = Math.max(0, runningEndSec - dur);
      videoFilters.push(
        `${vTag}${nextV}xfade=transition=${xfadeName}:duration=${dur.toFixed(3)}:offset=${offset.toFixed(3)},settb=1/90000${outV}`,
      );
      if (opts.hasAudio) {
        audioFilters.push(
          `${aTag}[${i + 1}:a]acrossfade=d=${dur.toFixed(3)}${outA}`,
        );
      }
      runningEndSec = offset + nextDur;
    } else {
      // Hard cut between scenes inside a mixed (xfade + cut) chain. Use the
      // `concat` filter to splice the next scene onto the accumulated chain
      // — `xfade duration=0` looks right syntactically but actually drops the
      // second input and silently truncates the output (verified on real
      // recordings). concat=n=2:v=1:a=0 / a=1 cleanly extends by the full
      // duration of the next clip.
      videoFilters.push(`${vTag}${nextV}concat=n=2:v=1:a=0,settb=1/90000${outV}`);
      if (opts.hasAudio) {
        audioFilters.push(`${aTag}[${i + 1}:a]concat=n=2:v=0:a=1${outA}`);
      }
      runningEndSec += nextDur;
    }
    vTag = outV;
    aTag = opts.hasAudio ? outA : aTag;
  }

  const filterComplex = [...videoFilters, ...audioFilters].join(';');

  const ffmpegArgs = [
    '-y',
    ...inputArgs,
    '-filter_complex', filterComplex,
    '-map', vTag,
    ...(opts.hasAudio ? ['-map', aTag] : []),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    ...(opts.hasAudio ? ['-c:a', 'aac', '-b:a', '192k'] : ['-an']),
    '-movflags', '+faststart',
    outputPath,
  ];
  await runFfmpeg(ffmpegArgs);
}

/**
 * Fast-path concat — no transitions. Uses the demuxer with `-c copy` when ALL
 * scenes have matching dimensions (the cheap, no-re-encode path). When any
 * scene's resolution differs from the first, falls back to a re-encode that
 * scales/pads each scene to a uniform size. Mismatched dimensions were
 * previously the cause of a subtle bug: `-c copy` doesn't error on the
 * mismatch but produces an output whose video stream silently truncates
 * partway through (the audio still plays — the user sees a frozen frame
 * while narration continues).
 */
async function concatScenesPlain(scenePaths: string[], outputPath: string, tmpDir: string, opts: ConcatOpts = { hasAudio: true }): Promise<void> {
  // Probe all scene dimensions AND time bases AND audio params up-front.
  // The concat demuxer's `-c copy` fast path fails silently when any of
  // these differ between inputs — the output looks valid by ffprobe
  // (duration is right, streams exist) but downstream tools see a
  // duplicated moov atom, NAL unit corruption, or AAC channel duplication.
  // The user reports as "render plays as a black box at 0:0.0".
  //
  // The mux step writes different video time bases depending on input frame
  // rate (a 30fps recording becomes 1/15360, a 60fps recording 1/60000),
  // so a multi-scene project nearly always has mixed time bases even when
  // dimensions match. We need to detect this and route to the re-encode
  // path which normalises every input to a single time base via the filter
  // graph.
  const [sizes, timeBases, audioParams] = await Promise.all([
    Promise.all(scenePaths.map((p) => probeVideoSize(p))),
    Promise.all(scenePaths.map((p) => probeVideoTimeBase(p))),
    opts.hasAudio
      ? Promise.all(scenePaths.map((p) => probeAudioParams(p)))
      : Promise.resolve([] as { sampleRate: number; channels: number; channelLayout: string }[]),
  ]);
  const first = sizes[0];
  const firstTb = timeBases[0];
  const firstAudio = audioParams[0];
  const dimsMatch = !!first && sizes.every((s) => s.width === first.width && s.height === first.height);
  const tbMatch = !!firstTb && timeBases.every((tb) => tb === firstTb);
  const audioMatch = !opts.hasAudio || !firstAudio || audioParams.every(
    (a) => a.sampleRate === firstAudio.sampleRate && a.channels === firstAudio.channels,
  );
  const uniform = dimsMatch && tbMatch && audioMatch;

  if (uniform) {
    const concatList = join(tmpDir, 'scenes-list.txt');
    const lines = scenePaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
    await writeFile(concatList, lines);
    try {
      await runFfmpeg([
        '-y', '-f', 'concat', '-safe', '0', '-i', concatList,
        '-c', 'copy', outputPath,
      ]);
      return;
    } catch (err) {
      if (!(err instanceof RenderError) || !/Non-monotonous|invalid|codec|negative/i.test(err.message)) {
        throw err;
      }
      // Fall through to the re-encode path below.
    }
  }

  // Re-encode path. Normalise every scene to a uniform width × height via
  // scale+pad (preserving aspect), then concat in the filter graph. Same
  // normalisation pattern as the xfade slow path.
  const targetW = first?.width || 1920;
  const targetH = first?.height || 1080;
  const normW = targetW + (targetW % 2);
  const normH = targetH + (targetH % 2);

  const inputArgs: string[] = [];
  for (const p of scenePaths) inputArgs.push('-i', p);

  const filters: string[] = [];
  for (let i = 0; i < scenePaths.length; i++) {
    // Same `fps=60,settb=1/90000` normalisation as the xfade slow path so
    // mixed-source inputs (bumpers + scenes) don't trip the concat filter
    // on timebase/framerate mismatches.
    filters.push(
      `[${i}:v]scale=${normW}:${normH}:force_original_aspect_ratio=decrease,` +
      `pad=${normW}:${normH}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=60,settb=1/90000[n${i}]`,
    );
  }
  // concat filter — when hasAudio, interleave v,a pairs; otherwise video only.
  if (opts.hasAudio) {
    const concatInputs = scenePaths.map((_p, i) => `[n${i}][${i}:a]`).join('');
    filters.push(`${concatInputs}concat=n=${scenePaths.length}:v=1:a=1[outv][outa]`);
  } else {
    const concatInputs = scenePaths.map((_p, i) => `[n${i}]`).join('');
    filters.push(`${concatInputs}concat=n=${scenePaths.length}:v=1:a=0[outv]`);
  }

  await runFfmpeg([
    '-y',
    ...inputArgs,
    '-filter_complex', filters.join(';'),
    '-map', '[outv]',
    ...(opts.hasAudio ? ['-map', '[outa]', '-c:a', 'aac', '-b:a', '192k'] : ['-an']),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-movflags', '+faststart',
    outputPath,
  ]);
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

/**
 * Probe a video's primary audio stream parameters. Used by the transition-clip
 * builder so the inserted clip's silent audio track matches the surrounding
 * scenes — without this, the concat-demuxer fast path with `-c copy` produces
 * a file whose audio streams can't be assembled by some players (they fall
 * back to 0:0.0). Returns sample_rate, channels, channel_layout, codec_name;
 * empty values when the file has no audio stream.
 */
export async function probeAudioParams(path: string): Promise<{
  sampleRate: number;
  channels: number;
  channelLayout: string;
}> {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-select_streams', 'a:0',
      '-show_entries', 'stream=sample_rate,channels,channel_layout',
      '-of', 'csv=p=0:s=x',
      path,
    ], { timeout: 30_000 });
    const parts = stdout.trim().split('x');
    const sampleRate = Number.parseInt(parts[0] ?? '0', 10) || 0;
    const channels = Number.parseInt(parts[1] ?? '0', 10) || 0;
    const channelLayout = parts[2] || '';
    return { sampleRate, channels, channelLayout };
  } catch {
    return { sampleRate: 0, channels: 0, channelLayout: '' };
  }
}

/**
 * Probe a video's primary stream time base (e.g. "1/15360"). Used by the
 * fast-path concat check — the concat demuxer with `-c copy` corrupts the
 * output when inputs have different time bases, even if dimensions match.
 * Returns the raw fraction string; "" on failure.
 */
async function probeVideoTimeBase(path: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=time_base',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      path,
    ], { timeout: 30_000 });
    return stdout.trim();
  } catch {
    return '';
  }
}

/**
 * Probe a video's primary stream width × height. Used by the xfade path so
 * scenes with mismatched resolutions can be scaled to a common target before
 * the filter graph runs (xfade refuses to merge streams of different sizes).
 */
export async function probeVideoSize(path: string): Promise<{ width: number; height: number }> {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'csv=p=0:s=x',
      path,
    ], { timeout: 30_000 });
    const [w, h] = stdout.trim().split('x').map((n) => Number.parseInt(n, 10));
    return { width: w || 0, height: h || 0 };
  } catch {
    return { width: 0, height: 0 };
  }
}

/** Probe whether a media file has an audio stream. Used by the bumper
 *  normaliser to decide whether to passthrough audio, transcode, or synthesise
 *  a silent track. */
async function probeHasAudio(path: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-select_streams', 'a',
      '-show_entries', 'stream=codec_type',
      '-of', 'csv=p=0',
      path,
    ], { timeout: 30_000 });
    return stdout.trim().split('\n').some((line) => line.includes('audio'));
  } catch {
    return false;
  }
}

/**
 * Normalise a brand bumper (intro/outro video) so it can join the project's
 * concat chain without breaking the filter graph. Output matches the rest of
 * the join inputs on resolution, pixel format, codec, and audio profile:
 *
 *   • Video: scaled + padded to target W×H, yuv420p, h264 (preset veryfast,
 *     CRF 20), 60fps cap (matches per-scene mp4s in practice).
 *   • Audio:
 *       - When `hasAudio=false`, audio is stripped entirely (`-an`).
 *       - When `hasAudio=true` and the bumper has an audio track, the track
 *         is transcoded to aac 44.1 kHz stereo to match the per-scene mp4s.
 *       - When `hasAudio=true` and the bumper has NO audio track, a silent
 *         aac stream is synthesised via `anullsrc` so concat doesn't trip on
 *         a missing audio input.
 *
 * Returns the path to the normalised mp4 in `tmpDir`.
 */
async function normaliseBumper(
  bumperPath: string,
  targetW: number,
  targetH: number,
  hasAudio: boolean,
  tmpDir: string,
  label: 'intro' | 'outro',
): Promise<string> {
  const outPath = join(tmpDir, `bumper-${label}.mp4`);
  const hadAudio = hasAudio ? await probeHasAudio(bumperPath) : false;
  const args: string[] = ['-y', '-i', bumperPath];
  if (hasAudio && !hadAudio) {
    // Synthesise a silent stereo track so the concat-with-audio path sees an
    // audio stream on every input. `-shortest` makes the lavfi input stop
    // when the video does (otherwise it'd stream forever).
    args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');
  }
  args.push(
    '-vf',
    `scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease,pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=60`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-pix_fmt', 'yuv420p',
  );
  if (!hasAudio) {
    args.push('-an');
  } else if (hadAudio) {
    args.push('-map', '0:v:0', '-map', '0:a:0', '-c:a', 'aac', '-b:a', '192k', '-ar', '44100', '-ac', '2');
  } else {
    args.push('-map', '0:v:0', '-map', '1:a:0', '-c:a', 'aac', '-b:a', '192k', '-ar', '44100', '-ac', '2', '-shortest');
  }
  args.push('-movflags', '+faststart', outPath);
  await runFfmpeg(args);
  return outPath;
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
