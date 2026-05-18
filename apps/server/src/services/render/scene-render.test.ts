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
        cb(null, { stdout: '10.0\n', stderr: '' });
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
        recording: { source: 'recordings/scene-1.mp4' },
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
