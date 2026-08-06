/**
 * Integration tests for `renderSingleScene` focused on the device-frame
 * pipeline. The non-frame happy path is exercised end-to-end elsewhere
 * (manual smoke tests) — these tests use DI seams + a mocked ffmpeg shell
 * helper to assert that:
 *   1. When a scene has `frame_style`, the framed cache video is produced
 *      and the final `combined.mp4` mux pulls from the framed file (not the
 *      bare overlay).
 *   2. When the cache is fresh, the frame renderer is NOT invoked again.
 *   3. When no `frame_style` is set, the frame pipeline is bypassed entirely.
 *
 * We mock `node:child_process` so the real ffmpeg binary is never invoked.
 * That lets us capture every ffmpeg arg list and inspect the video input to
 * the mux step.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, utimes } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveStoryboard } from '../storyboard/index.js';
import type { Storyboard } from '@vpa/shared';
import type { FrameManifest } from '../frame/manifest.js';
import type { FrameRenderer } from '../frame/render.js';

// ── Mock the spawn helper used by runFfmpeg + probeDuration ─────────────────

const ffmpegCalls: { cmd: string; args: string[] }[] = [];
const probeDurations = new Map<string, number>();

vi.mock('node:child_process', () => ({
  execFile: vi.fn(
    (
      cmd: string,
      args: string[],
      _opts: unknown,
      cb: (err: unknown, result: { stdout: string; stderr: string }) => void,
    ) => {
      ffmpegCalls.push({ cmd, args });

      // probeDuration calls `ffprobe`; return a plausible duration so the
      // (real) frame renderer would have something to put in `-t`.
      if (cmd === 'ffprobe') {
        const mediaPath = args[args.length - 1] ?? '';
        cb(null, { stdout: `${probeDurations.get(mediaPath) ?? 10}\n`, stderr: '' });
        return;
      }

      // For ffmpeg: write an empty stub at the output path (last positional)
      // so downstream existsSync checks pass.
      const outPath = args[args.length - 1];
      if (typeof outPath === 'string' && !outPath.startsWith('-')) {
        void import('node:fs/promises')
          .then((m) => m.writeFile(outPath, ''))
          .then(() => cb(null, { stdout: '', stderr: '' }))
          .catch((err) => cb(err, { stdout: '', stderr: String(err) }));
        return;
      }
      cb(null, { stdout: '', stderr: '' });
    },
  ),
}));

// Import AFTER vi.mock so runFfmpeg uses the mocked child_process.
const { renderSingleScene } = await import('./scene-render.js');
const { renderFinalVideo } = await import('./index.js');

// ── Fixture builders ─────────────────────────────────────────────────────────

const SCENE_ID = '00000000-0000-4000-8000-000000000001';

const manifest: FrameManifest = {
  version: 1,
  frames: [
    {
      id: 'laptop-flat',
      family: 'laptop',
      variant: 'flat',
      displayName: 'MacBook (flat)',
      frame: 'frames/laptop-flat.png',
      thumbnail: 'thumbnails/laptop-flat.png',
      type: 'flat',
      frameSize: { w: 1920, h: 1200 },
      inset: { x: 80, y: 80, w: 1760, h: 1100 },
    },
  ],
};

function makeStoryboard(extra: Partial<Storyboard['scenes'][number]> = {}): Storyboard {
  return {
    schema_version: 1,
    project: {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Test Project',
      created: '2026-05-18T00:00:00.000Z',
    },
    scenes: [
      {
        id: SCENE_ID,
        name: 'Scene 1',
        description: '',
        type: 'desktop',
        recording: { source: 'recordings/scene-1.mp4', duration_sec: 10 },
        ...extra,
      },
    ],
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('renderSingleScene — frame integration', () => {
  let projectPath: string;

  beforeEach(async () => {
    ffmpegCalls.length = 0;
    probeDurations.clear();
    projectPath = await mkdtemp(join(tmpdir(), 'vpa-scene-render-'));
    await mkdir(join(projectPath, 'recordings'), { recursive: true });
    await writeFile(join(projectPath, 'recordings', 'scene-1.mp4'), 'fake-recording');
  });

  afterEach(async () => {
    await rm(projectPath, { recursive: true, force: true });
  });

  it('passes the framed cache file as the mux input when frame_style is set', async () => {
    const sb = makeStoryboard({ frame_style: 'laptop-flat' });
    await saveStoryboard(projectPath, sb);

    let frameRendererCalls = 0;
    let framedOutputPath: string | null = null;
    const fakeFrameRenderer: FrameRenderer = async (opts) => {
      frameRendererCalls += 1;
      framedOutputPath = opts.outputPath;
      // Simulate the frame renderer writing its output file.
      await writeFile(opts.outputPath, 'framed-bytes');
    };

    await renderSingleScene(
      {
        projectPath,
        sceneId: SCENE_ID,
        vpaHome: '/fake/vpa-home',
        workspaceRoot: '/fake/workspace',
        __frameDeps: {
          manifest,
          frameRenderer: fakeFrameRenderer,
          assetsDir: '/fake/assets',
        },
      },
      { audioMode: 'replace' },
    );

    expect(frameRendererCalls).toBe(1);
    expect(framedOutputPath).toBe(
      join(projectPath, 'renders', '.frame', `${SCENE_ID}-framed.mp4`),
    );

    // The mux call should reference the framed file as its first -i input,
    // not the bare overlay.mp4 path. Find the ffmpeg call whose last arg is
    // combined.mp4 — that's the mux step.
    const muxCall = ffmpegCalls.find(
      (c) =>
        c.cmd === 'ffmpeg' &&
        c.args[c.args.length - 1]?.endsWith(join('renders', 'scenes', SCENE_ID, 'combined.mp4')),
    );
    expect(muxCall, 'expected a ffmpeg mux call to write combined.mp4').toBeDefined();
    const firstInputIdx = muxCall!.args.indexOf('-i');
    expect(firstInputIdx).toBeGreaterThanOrEqual(0);
    expect(muxCall!.args[firstInputIdx + 1]).toBe(framedOutputPath);
  });

  it('skips the frame renderer when no frame_style is set', async () => {
    const sb = makeStoryboard();
    await saveStoryboard(projectPath, sb);

    let frameRendererCalls = 0;
    const fakeFrameRenderer: FrameRenderer = async () => {
      frameRendererCalls += 1;
    };

    await renderSingleScene(
      {
        projectPath,
        sceneId: SCENE_ID,
        vpaHome: '/fake/vpa-home',
        workspaceRoot: '/fake/workspace',
        __frameDeps: {
          manifest,
          frameRenderer: fakeFrameRenderer,
          assetsDir: '/fake/assets',
        },
      },
      { audioMode: 'replace' },
    );

    expect(frameRendererCalls).toBe(0);
    expect(
      existsSync(join(projectPath, 'renders', '.frame', `${SCENE_ID}-framed.mp4`)),
    ).toBe(false);

    // Mux should reference overlay.mp4 directly.
    const muxCall = ffmpegCalls.find(
      (c) =>
        c.cmd === 'ffmpeg' &&
        c.args[c.args.length - 1]?.endsWith(join('renders', 'scenes', SCENE_ID, 'combined.mp4')),
    );
    expect(muxCall).toBeDefined();
    const firstInputIdx = muxCall!.args.indexOf('-i');
    expect(muxCall!.args[firstInputIdx + 1]).toBe(
      join(projectPath, 'renders', 'scenes', SCENE_ID, 'overlay.mp4'),
    );
  });

  it('reuses the cached frame_render when it is newer than the upstream', async () => {
    const sb = makeStoryboard({ frame_style: 'laptop-flat' });
    await saveStoryboard(projectPath, sb);

    // Pre-stage the cached framed file with a far-future mtime so the
    // cache-fresh branch wins over any overlay.mp4 we write during the run.
    const cacheDir = join(projectPath, 'renders', '.frame');
    await mkdir(cacheDir, { recursive: true });
    const cachePath = join(cacheDir, `${SCENE_ID}-framed.mp4`);
    await writeFile(cachePath, 'cached-framed');
    const future = new Date(Date.now() + 60_000);
    await utimes(cachePath, future, future);

    let frameRendererCalls = 0;
    const fakeFrameRenderer: FrameRenderer = async () => {
      frameRendererCalls += 1;
    };

    await renderSingleScene(
      {
        projectPath,
        sceneId: SCENE_ID,
        vpaHome: '/fake/vpa-home',
        workspaceRoot: '/fake/workspace',
        __frameDeps: {
          manifest,
          frameRenderer: fakeFrameRenderer,
          assetsDir: '/fake/assets',
        },
      },
      { audioMode: 'replace' },
    );

    expect(frameRendererCalls).toBe(0);

    // Mux still consumes the cached framed file.
    const muxCall = ffmpegCalls.find(
      (c) =>
        c.cmd === 'ffmpeg' &&
        c.args[c.args.length - 1]?.endsWith(join('renders', 'scenes', SCENE_ID, 'combined.mp4')),
    );
    expect(muxCall).toBeDefined();
    const firstInputIdx = muxCall!.args.indexOf('-i');
    expect(muxCall!.args[firstInputIdx + 1]).toBe(cachePath);
  });
});

describe('presentation scene duration rendering', () => {
  let projectPath: string;

  beforeEach(async () => {
    ffmpegCalls.length = 0;
    probeDurations.clear();
    projectPath = await mkdtemp(join(tmpdir(), 'vpa-presentation-render-'));
    await mkdir(join(projectPath, 'presentations', '1e570aa5-20ce-4779-ad9a-d4db3ae73991', 'clips'), { recursive: true });
    await mkdir(join(projectPath, 'presentations', '1e570aa5-20ce-4779-ad9a-d4db3ae73991', 'pages'), { recursive: true });
    await mkdir(join(projectPath, 'narration'), { recursive: true });
    await writeFile(join(projectPath, 'presentations', '1e570aa5-20ce-4779-ad9a-d4db3ae73991', 'clips', 'page-0001.mp4'), 'slide');
    await writeFile(join(projectPath, 'presentations', '1e570aa5-20ce-4779-ad9a-d4db3ae73991', 'pages', 'page-0001.png'), 'image');
    await writeFile(join(projectPath, 'narration', 'slide.mp3'), 'narration');
  });

  afterEach(async () => {
    await rm(projectPath, { recursive: true, force: true });
  });

  function presentationStoryboard(withNarration = true): Storyboard {
    return {
      schema_version: 1,
      project: {
        id: '11111111-1111-4111-8111-111111111111',
        name: 'Slides',
        created: '2026-08-05T00:00:00.000Z',
      },
      scenes: [{
        id: SCENE_ID,
        name: 'Slide 1',
        description: 'Opening slide',
        type: 'slide',
        recording: {
          source: 'presentations/1e570aa5-20ce-4779-ad9a-d4db3ae73991/clips/page-0001.mp4',
          source_kind: 'presentation',
          duration_sec: 1,
        },
        presentation_source: {
          presentation_id: '1e570aa5-20ce-4779-ad9a-d4db3ae73991',
          page_number: 1,
          page_count: 1,
          image: 'presentations/1e570aa5-20ce-4779-ad9a-d4db3ae73991/pages/page-0001.png',
          hold_duration_sec: 5,
        },
        narration: withNarration ? { script: 'Welcome', audio: 'narration/slide.mp3' } : undefined,
      }],
    };
  }

  function outputCall(suffix: string) {
    return ffmpegCalls.find((call) => call.cmd === 'ffmpeg' && call.args.at(-1)?.endsWith(suffix));
  }

  it('full-project render pads then trims a slide to longer narration and probes narration once', async () => {
    await saveStoryboard(projectPath, presentationStoryboard());
    const clipPath = join(projectPath, 'presentations', '1e570aa5-20ce-4779-ad9a-d4db3ae73991', 'clips', 'page-0001.mp4');
    const narrationPath = join(projectPath, 'narration', 'slide.mp3');
    probeDurations.set(clipPath, 1);
    probeDurations.set(narrationPath, 8.25);

    await renderFinalVideo(projectPath);

    const muxCall = outputCall(join('renders', 'scene-01-Slide-1.mp4'));
    expect(muxCall).toBeDefined();
    expect(muxCall!.args.join(' ')).toContain('tpad=stop_mode=clone:stop_duration=7.250,trim=duration=8.250,setpts=PTS-STARTPTS');
    expect(muxCall!.args).toEqual(expect.arrayContaining(['-map', '[v]', '-map', '1:a:0']));
    expect(muxCall!.args).not.toContain('-shortest');
    expect(ffmpegCalls.filter((call) => call.cmd === 'ffprobe' && call.args.at(-1) === narrationPath)).toHaveLength(1);
  });

  it('single-scene render pads then trims a slide to longer narration and probes narration once', async () => {
    await saveStoryboard(projectPath, presentationStoryboard());
    const overlayPath = join(projectPath, 'renders', 'scenes', SCENE_ID, 'overlay.mp4');
    const narrationPath = join(projectPath, 'renders', 'scenes', SCENE_ID, 'narration.mp3');
    probeDurations.set(overlayPath, 1);
    probeDurations.set(narrationPath, 8.25);

    await renderSingleScene({ projectPath, sceneId: SCENE_ID, vpaHome: '', workspaceRoot: '' });

    const muxCall = outputCall(join('renders', 'scenes', SCENE_ID, 'combined.mp4'));
    expect(muxCall).toBeDefined();
    expect(muxCall!.args.join(' ')).toContain('tpad=stop_mode=clone:stop_duration=7.250,trim=duration=8.250,setpts=PTS-STARTPTS');
    expect(muxCall!.args).toEqual(expect.arrayContaining(['-map', '[v]', '-map', '1:a:0']));
    expect(muxCall!.args).not.toContain('-shortest');
    expect(ffmpegCalls.filter((call) => call.cmd === 'ffprobe' && call.args.at(-1) === narrationPath)).toHaveLength(1);
  });

  it('uses the hold without narration and trims narration shorter than the physical slide clip', async () => {
    await saveStoryboard(projectPath, presentationStoryboard(false));
    const overlayPath = join(projectPath, 'renders', 'scenes', SCENE_ID, 'overlay.mp4');
    probeDurations.set(overlayPath, 1);
    await renderSingleScene({ projectPath, sceneId: SCENE_ID, vpaHome: '', workspaceRoot: '' });
    let muxCall = outputCall(join('renders', 'scenes', SCENE_ID, 'combined.mp4'))!;
    expect(muxCall.args.join(' ')).toContain('trim=duration=5.000,setpts=PTS-STARTPTS');
    expect(muxCall.args).toEqual(expect.arrayContaining(['-map', '[v]', '-an']));

    ffmpegCalls.length = 0;
    await saveStoryboard(projectPath, presentationStoryboard(true));
    const narrationPath = join(projectPath, 'renders', 'scenes', SCENE_ID, 'narration.mp3');
    probeDurations.set(overlayPath, 1);
    probeDurations.set(narrationPath, 0.75);
    await renderSingleScene({ projectPath, sceneId: SCENE_ID, vpaHome: '', workspaceRoot: '' });
    muxCall = outputCall(join('renders', 'scenes', SCENE_ID, 'combined.mp4'))!;
    expect(muxCall.args.join(' ')).not.toContain('tpad=stop_mode=clone');
    expect(muxCall.args.join(' ')).toContain('trim=duration=0.750,setpts=PTS-STARTPTS');
    expect(muxCall.args).toEqual(expect.arrayContaining(['-map', '[v]', '-map', '1:a:0']));
    expect(muxCall.args).not.toContain('-shortest');
    expect(ffmpegCalls.filter((call) => call.cmd === 'ffprobe' && call.args.at(-1) === narrationPath)).toHaveLength(1);
  });

  it('applies the hold and shorter narration exactly in the full-project path', async () => {
    const clipPath = join(projectPath, 'presentations', '1e570aa5-20ce-4779-ad9a-d4db3ae73991', 'clips', 'page-0001.mp4');
    probeDurations.set(clipPath, 1);
    await saveStoryboard(projectPath, presentationStoryboard(false));

    await renderFinalVideo(projectPath);

    let muxCall = outputCall(join('renders', 'scene-01-Slide-1.mp4'))!;
    expect(muxCall.args.join(' ')).toContain('trim=duration=5.000,setpts=PTS-STARTPTS');
    expect(muxCall.args).toEqual(expect.arrayContaining(['-map', '[v]', '-an']));

    ffmpegCalls.length = 0;
    await saveStoryboard(projectPath, presentationStoryboard(true));
    const narrationPath = join(projectPath, 'narration', 'slide.mp3');
    probeDurations.set(narrationPath, 0.75);

    await renderFinalVideo(projectPath);

    muxCall = outputCall(join('renders', 'scene-01-Slide-1.mp4'))!;
    expect(muxCall.args.join(' ')).not.toContain('tpad=stop_mode=clone');
    expect(muxCall.args.join(' ')).toContain('trim=duration=0.750,setpts=PTS-STARTPTS');
    expect(muxCall.args).toEqual(expect.arrayContaining(['-map', '[v]', '-map', '1:a:0']));
    expect(muxCall.args).not.toContain('-shortest');
    expect(ffmpegCalls.filter((call) => call.cmd === 'ffprobe' && call.args.at(-1) === narrationPath)).toHaveLength(1);
  });

  it('uses the hold when full-project narration is excluded despite valid stored chunk timing', async () => {
    const sb = presentationStoryboard(false);
    sb.scenes[0]!.narration = {
      script: 'Stored narration',
      chunks: [{
        index: 0,
        text: 'Stored narration',
        audio: 'narration/slide.mp3',
        durationSec: 8.25,
      }],
    };
    await saveStoryboard(projectPath, sb);
    const clipPath = join(projectPath, 'presentations', '1e570aa5-20ce-4779-ad9a-d4db3ae73991', 'clips', 'page-0001.mp4');
    const narrationPath = join(projectPath, 'narration', 'slide.mp3');
    probeDurations.set(clipPath, 1);
    probeDurations.set(narrationPath, 8.25);

    await renderFinalVideo(projectPath, { includeNarration: false });

    const muxCall = outputCall(join('renders', 'scene-01-Slide-1.mp4'))!;
    expect(muxCall.args.join(' ')).toContain('trim=duration=5.000,setpts=PTS-STARTPTS');
    expect(muxCall.args).toEqual(expect.arrayContaining(['-map', '[v]', '-an']));
    expect(ffmpegCalls.filter((call) => call.cmd === 'ffprobe' && call.args.at(-1) === narrationPath)).toHaveLength(0);
  });

  it('uses the hold when stored chunks have timing but no available audio', async () => {
    const sb = presentationStoryboard(false);
    sb.scenes[0]!.narration = {
      script: 'Unavailable narration',
      chunks: [{
        index: 0,
        text: 'Unavailable narration',
        audio: 'narration/missing.mp3',
        durationSec: 8.25,
      }],
    };
    await saveStoryboard(projectPath, sb);
    const overlayPath = join(projectPath, 'renders', 'scenes', SCENE_ID, 'overlay.mp4');
    probeDurations.set(overlayPath, 1);

    const result = await renderSingleScene({ projectPath, sceneId: SCENE_ID, vpaHome: '', workspaceRoot: '' });

    const muxCall = outputCall(join('renders', 'scenes', SCENE_ID, 'combined.mp4'))!;
    expect(result.narrationPath).toBeNull();
    expect(muxCall.args.join(' ')).toContain('trim=duration=5.000,setpts=PTS-STARTPTS');
    expect(muxCall.args).toEqual(expect.arrayContaining(['-map', '[v]', '-an']));
  });

  it('treats presentation mix as replacement in both render paths because slide clips are silent', async () => {
    await saveStoryboard(projectPath, presentationStoryboard(true));
    const clipPath = join(projectPath, 'presentations', '1e570aa5-20ce-4779-ad9a-d4db3ae73991', 'clips', 'page-0001.mp4');
    const fullNarrationPath = join(projectPath, 'narration', 'slide.mp3');
    probeDurations.set(clipPath, 1);
    probeDurations.set(fullNarrationPath, 8.25);

    await renderFinalVideo(projectPath, { audioMode: 'mix' });

    let muxCall = outputCall(join('renders', 'scene-01-Slide-1.mp4'))!;
    expect(muxCall.args.join(' ')).not.toContain('[0:a]');
    expect(muxCall.args).toEqual(expect.arrayContaining(['-map', '[v]', '-map', '1:a:0']));

    ffmpegCalls.length = 0;
    const overlayPath = join(projectPath, 'renders', 'scenes', SCENE_ID, 'overlay.mp4');
    const sceneNarrationPath = join(projectPath, 'renders', 'scenes', SCENE_ID, 'narration.mp3');
    probeDurations.set(overlayPath, 1);
    probeDurations.set(sceneNarrationPath, 8.25);

    await renderSingleScene(
      { projectPath, sceneId: SCENE_ID, vpaHome: '', workspaceRoot: '' },
      { audioMode: 'mix' },
    );

    muxCall = outputCall(join('renders', 'scenes', SCENE_ID, 'combined.mp4'))!;
    expect(muxCall.args.join(' ')).not.toContain('[0:a]');
    expect(muxCall.args).toEqual(expect.arrayContaining(['-map', '[v]', '-map', '1:a:0']));
    expect(muxCall.args).not.toContain('-shortest');
  });

  it('preserves ordinary recording mix graphs', async () => {
    await mkdir(join(projectPath, 'recordings'), { recursive: true });
    await writeFile(join(projectPath, 'recordings', 'scene-1.mp4'), 'recording');
    await saveStoryboard(projectPath, makeStoryboard({
      recording: { source: 'recordings/scene-1.mp4', duration_sec: 30 },
      narration: { script: 'Normal narration', audio: 'narration/slide.mp3' },
    }));

    await renderSingleScene(
      { projectPath, sceneId: SCENE_ID, vpaHome: '', workspaceRoot: '' },
      { audioMode: 'mix' },
    );

    const muxCall = outputCall(join('renders', 'scenes', SCENE_ID, 'combined.mp4'))!;
    expect(muxCall.args.join(' ')).toContain('[0:a]volume=0.1');
    expect(muxCall.args).toEqual(expect.arrayContaining(['-map', '0:v:0', '-map', '[aout]']));
  });

  it('keeps ordinary single-scene replacement audio behavior', async () => {
    await mkdir(join(projectPath, 'recordings'), { recursive: true });
    await writeFile(join(projectPath, 'recordings', 'scene-1.mp4'), 'recording');
    const sb = makeStoryboard({
      recording: { source: 'recordings/scene-1.mp4', duration_sec: 30 },
      narration: { script: 'Normal narration', audio: 'narration/slide.mp3' },
    });
    await saveStoryboard(projectPath, sb);

    await renderSingleScene({ projectPath, sceneId: SCENE_ID, vpaHome: '', workspaceRoot: '' });

    const muxCall = outputCall(join('renders', 'scenes', SCENE_ID, 'combined.mp4'))!;
    expect(muxCall.args).toContain('-shortest');
    expect(muxCall.args.join(' ')).not.toContain('trim=duration=');
    expect(muxCall.args).toEqual(expect.arrayContaining(['-map', '0:v:0', '-map', '1:a:0']));
  });

  it('keeps ordinary full-project replacement audio behavior', async () => {
    await mkdir(join(projectPath, 'recordings'), { recursive: true });
    await writeFile(join(projectPath, 'recordings', 'scene-1.mp4'), 'recording');
    const sb = makeStoryboard({
      recording: { source: 'recordings/scene-1.mp4', duration_sec: 30 },
      narration: { script: 'Normal narration', audio: 'narration/slide.mp3' },
    });
    await saveStoryboard(projectPath, sb);

    await renderFinalVideo(projectPath);

    const muxCall = outputCall(join('renders', 'scene-01-Scene-1.mp4'))!;
    expect(muxCall.args.join(' ')).not.toContain('trim=duration=');
    expect(muxCall.args).toEqual(expect.arrayContaining(['-map', '0:v:0', '-map', '1:a:0']));
  });
});
