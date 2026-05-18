import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFlatFilter, buildPerspectiveFilter, createFrameRenderer } from './render.js';
import type { FlatFrame, PerspectiveFrame } from './manifest.js';
import { runFfmpeg, probeDuration } from '../render/index.js';

// ── Sample fixture ────────────────────────────────────────────────────────────

const sampleEntry: FlatFrame = {
  id: 'macbook-pro-16-silver',
  family: 'macbook-pro',
  variant: '16-silver',
  displayName: 'MacBook Pro 16" Silver',
  frame: 'macbook-pro-16-silver.png',
  thumbnail: 'macbook-pro-16-silver-thumb.png',
  type: 'flat',
  frameSize: { w: 2560, h: 1600 },
  inset: { x: 320, y: 200, w: 1920, h: 1080 },
};

const samplePerspective: PerspectiveFrame = {
  id: 'laptop-tilt-right',
  family: 'laptop',
  variant: 'tilt-right',
  displayName: 'MacBook (tilted right)',
  frame: 'frames/laptop-tilt-right.png',
  thumbnail: 'thumbnails/laptop-tilt-right.png',
  frameSize: { w: 2000, h: 1400 },
  type: 'perspective',
  quad: {
    tl: { x: 200, y: 120 },
    tr: { x: 1800, y: 250 },
    br: { x: 1750, y: 1200 },
    bl: { x: 250, y: 1100 },
  },
};

const BG_HEX = '#1a2b3c';
const ASSETS_DIR = '/fake/assets';
const INPUT_VIDEO = '/fake/input.mp4';
const OUTPUT_PATH = '/fake/output.mp4';

// ── buildFlatFilter pure unit tests ──────────────────────────────────────────

describe('buildFlatFilter', () => {
  it('throws a clear error when backgroundColor is transparent', () => {
    expect(() => buildFlatFilter(sampleEntry, 'transparent')).toThrowError(
      /mp4|alpha/i,
    );
  });

  it('uses scale with force_original_aspect_ratio=decrease', () => {
    const filter = buildFlatFilter(sampleEntry, BG_HEX);
    expect(filter).toContain('scale=1920:1080:force_original_aspect_ratio=decrease');
  });

  it('contains a pad step matching the inset dimensions', () => {
    const filter = buildFlatFilter(sampleEntry, BG_HEX);
    expect(filter).toContain('pad=1920:1080:');
  });

  it('pad uses the background color', () => {
    const filter = buildFlatFilter(sampleEntry, BG_HEX);
    // #1a2b3c → 0x1a2b3c
    expect(filter).toContain('pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x1a2b3c');
  });

  it('contains a color= source with the frame dimensions', () => {
    const filter = buildFlatFilter(sampleEntry, BG_HEX);
    expect(filter).toContain('s=2560x1600');
  });

  it('first overlay positions at inset offset (INSET_X:INSET_Y)', () => {
    const filter = buildFlatFilter(sampleEntry, BG_HEX);
    expect(filter).toContain('overlay=320:200');
  });

  it('second overlay (frame PNG on top) positions at 0:0', () => {
    const filter = buildFlatFilter(sampleEntry, BG_HEX);
    expect(filter).toContain('overlay=0:0');
  });

  it('converts hex color to 0x-prefixed form for ffmpeg', () => {
    const filter = buildFlatFilter(sampleEntry, '#1a1a1a');
    expect(filter).toContain('0x1a1a1a');
    // Must NOT have a bare # in the filter (shell-unsafe)
    expect(filter).not.toContain('#1a1a1a');
  });

  it('includes format=yuva420p on the scaled/padded video', () => {
    const filter = buildFlatFilter(sampleEntry, BG_HEX);
    expect(filter).toContain('format=yuva420p');
  });

  it('color source uses 0x-prefixed background color', () => {
    const filter = buildFlatFilter(sampleEntry, '#aabbcc');
    expect(filter).toContain('color=c=0xaabbcc');
  });
});

// ── buildPerspectiveFilter pure unit tests ────────────────────────────────────

describe('buildPerspectiveFilter', () => {
  it('throws a clear error when backgroundColor is transparent', () => {
    expect(() => buildPerspectiveFilter(samplePerspective, 'transparent')).toThrowError(
      /mp4|alpha/i,
    );
  });

  it('scales the pre-warp video to the full frame dimensions', () => {
    // We scale source to frame size so the source's canvas corners
    // coincide with the (0,0)/(FW,0)/(0,FH)/(FW,FH) reference for perspective's
    // `sense=destination` mode — quad corners can then be used directly.
    const filter = buildPerspectiveFilter(samplePerspective, BG_HEX);
    expect(filter).toContain('scale=2000:1400');
  });

  it('emits perspective destination corners in ffmpeg order (tl, tr, bl, br)', () => {
    const filter = buildPerspectiveFilter(samplePerspective, BG_HEX);
    // tl(200,120), tr(1800,250), bl(250,1100), br(1750,1200)
    expect(filter).toContain('x0=200:y0=120');
    expect(filter).toContain('x1=1800:y1=250');
    expect(filter).toContain('x2=250:y2=1100');
    expect(filter).toContain('x3=1750:y3=1200');
  });

  it('uses sense=destination', () => {
    const filter = buildPerspectiveFilter(samplePerspective, BG_HEX);
    expect(filter).toContain('sense=destination');
  });

  it('uses interpolation=linear', () => {
    const filter = buildPerspectiveFilter(samplePerspective, BG_HEX);
    expect(filter).toContain('interpolation=linear');
  });

  it('emits a background color source matching the frame dimensions', () => {
    const filter = buildPerspectiveFilter(samplePerspective, BG_HEX);
    expect(filter).toContain('color=c=0x1a2b3c:s=2000x1400:d=86400');
  });

  it('first overlay places the warped video at 0:0', () => {
    // The perspective output IS frame-sized, so it overlays at the origin.
    const filter = buildPerspectiveFilter(samplePerspective, BG_HEX);
    // overlay=0:0 appears twice — once for the warped video, once for the PNG.
    const matches = filter.match(/overlay=0:0/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('second overlay places the frame PNG at 0:0', () => {
    const filter = buildPerspectiveFilter(samplePerspective, BG_HEX);
    // The last overlay in the chain uses input [1:v] (the frame PNG).
    expect(filter).toContain('[1:v]overlay=0:0');
  });

  it('converts hex color to 0x-prefixed form for ffmpeg', () => {
    const filter = buildPerspectiveFilter(samplePerspective, '#abcdef');
    expect(filter).toContain('0xabcdef');
    expect(filter).not.toContain('#abcdef');
  });

  it('includes a perspective= step', () => {
    const filter = buildPerspectiveFilter(samplePerspective, BG_HEX);
    expect(filter).toContain('perspective=');
  });
});

// ── createFrameRenderer integration tests (fake ffmpeg) ──────────────────────

describe('createFrameRenderer', () => {
  let capturedArgs: string[];
  let fakeRunFfmpeg: (args: string[]) => Promise<void>;
  let fakeProbeDuration: (path: string) => Promise<number>;

  beforeEach(() => {
    capturedArgs = [];
    fakeRunFfmpeg = async (args: string[]) => {
      capturedArgs = args;
    };
    fakeProbeDuration = async (_path: string) => 12.5;
  });

  it('calls probeDuration on the input video', async () => {
    const probeArgs: string[] = [];
    const spyProbe = async (p: string) => { probeArgs.push(p); return 12.5; };

    const render = createFrameRenderer({ runFfmpeg: fakeRunFfmpeg, probeDuration: spyProbe });
    await render({
      inputVideo: INPUT_VIDEO,
      frameEntry: sampleEntry,
      assetsDir: ASSETS_DIR,
      backgroundColor: BG_HEX,
      outputPath: OUTPUT_PATH,
    });

    expect(probeArgs).toContain(INPUT_VIDEO);
  });

  it('passes input video as first -i argument', async () => {
    const render = createFrameRenderer({ runFfmpeg: fakeRunFfmpeg, probeDuration: fakeProbeDuration });
    await render({
      inputVideo: INPUT_VIDEO,
      frameEntry: sampleEntry,
      assetsDir: ASSETS_DIR,
      backgroundColor: BG_HEX,
      outputPath: OUTPUT_PATH,
    });

    // First -i must be the input video
    const firstIIdx = capturedArgs.indexOf('-i');
    expect(firstIIdx).toBeGreaterThan(-1);
    expect(capturedArgs[firstIIdx + 1]).toBe(INPUT_VIDEO);
  });

  it('passes frame PNG as second input with -loop 1', async () => {
    const render = createFrameRenderer({ runFfmpeg: fakeRunFfmpeg, probeDuration: fakeProbeDuration });
    await render({
      inputVideo: INPUT_VIDEO,
      frameEntry: sampleEntry,
      assetsDir: ASSETS_DIR,
      backgroundColor: BG_HEX,
      outputPath: OUTPUT_PATH,
    });

    // Frame PNG path = assetsDir + frameEntry.frame
    const expectedPng = `${ASSETS_DIR}/${sampleEntry.frame}`;

    // Look for -loop 1 before the frame PNG
    const pngIdx = capturedArgs.indexOf(expectedPng);
    expect(pngIdx).toBeGreaterThan(-1);
    expect(capturedArgs[pngIdx - 1]).toBe('-i');
    // -loop 1 should appear before the second -i
    const loopIdx = capturedArgs.lastIndexOf('-loop', pngIdx);
    expect(loopIdx).toBeGreaterThan(-1);
    expect(capturedArgs[loopIdx + 1]).toBe('1');
  });

  it('includes -t with the probed duration', async () => {
    const render = createFrameRenderer({ runFfmpeg: fakeRunFfmpeg, probeDuration: fakeProbeDuration });
    await render({
      inputVideo: INPUT_VIDEO,
      frameEntry: sampleEntry,
      assetsDir: ASSETS_DIR,
      backgroundColor: BG_HEX,
      outputPath: OUTPUT_PATH,
    });

    const tIdx = capturedArgs.indexOf('-t');
    expect(tIdx).toBeGreaterThan(-1);
    expect(capturedArgs[tIdx + 1]).toBe('12.5');
  });

  it('includes -filter_complex matching buildFlatFilter output', async () => {
    const render = createFrameRenderer({ runFfmpeg: fakeRunFfmpeg, probeDuration: fakeProbeDuration });
    await render({
      inputVideo: INPUT_VIDEO,
      frameEntry: sampleEntry,
      assetsDir: ASSETS_DIR,
      backgroundColor: BG_HEX,
      outputPath: OUTPUT_PATH,
    });

    const fcIdx = capturedArgs.indexOf('-filter_complex');
    expect(fcIdx).toBeGreaterThan(-1);

    const expectedFilter = buildFlatFilter(sampleEntry, BG_HEX);
    expect(capturedArgs[fcIdx + 1]).toBe(expectedFilter);
  });

  it('includes correct codec args', async () => {
    const render = createFrameRenderer({ runFfmpeg: fakeRunFfmpeg, probeDuration: fakeProbeDuration });
    await render({
      inputVideo: INPUT_VIDEO,
      frameEntry: sampleEntry,
      assetsDir: ASSETS_DIR,
      backgroundColor: BG_HEX,
      outputPath: OUTPUT_PATH,
    });

    expect(capturedArgs).toContain('-c:v');
    expect(capturedArgs).toContain('libx264');
    expect(capturedArgs).toContain('-preset');
    expect(capturedArgs).toContain('veryfast');
    expect(capturedArgs).toContain('-crf');
    expect(capturedArgs).toContain('20');
    expect(capturedArgs).toContain('-c:a');
    expect(capturedArgs).toContain('copy');
  });

  it('pins -pix_fmt yuv420p to avoid libx264 alpha deprecation warning', async () => {
    const render = createFrameRenderer({ runFfmpeg: fakeRunFfmpeg, probeDuration: fakeProbeDuration });
    await render({
      inputVideo: INPUT_VIDEO,
      frameEntry: sampleEntry,
      assetsDir: ASSETS_DIR,
      backgroundColor: BG_HEX,
      outputPath: OUTPUT_PATH,
    });

    const pixFmtIdx = capturedArgs.indexOf('-pix_fmt');
    expect(pixFmtIdx).toBeGreaterThan(-1);
    expect(capturedArgs[pixFmtIdx + 1]).toBe('yuv420p');
  });

  it('last arg is the output path', async () => {
    const render = createFrameRenderer({ runFfmpeg: fakeRunFfmpeg, probeDuration: fakeProbeDuration });
    await render({
      inputVideo: INPUT_VIDEO,
      frameEntry: sampleEntry,
      assetsDir: ASSETS_DIR,
      backgroundColor: BG_HEX,
      outputPath: OUTPUT_PATH,
    });

    expect(capturedArgs[capturedArgs.length - 1]).toBe(OUTPUT_PATH);
  });

  it('propagates transparent error from buildFlatFilter', async () => {
    const render = createFrameRenderer({ runFfmpeg: fakeRunFfmpeg, probeDuration: fakeProbeDuration });
    await expect(
      render({
        inputVideo: INPUT_VIDEO,
        frameEntry: sampleEntry,
        assetsDir: ASSETS_DIR,
        backgroundColor: 'transparent',
        outputPath: OUTPUT_PATH,
      }),
    ).rejects.toThrowError(/mp4|alpha/i);
  });

  it('includes -map [out] to select the composited output stream', async () => {
    const render = createFrameRenderer({ runFfmpeg: fakeRunFfmpeg, probeDuration: fakeProbeDuration });
    await render({
      inputVideo: INPUT_VIDEO,
      frameEntry: sampleEntry,
      assetsDir: ASSETS_DIR,
      backgroundColor: BG_HEX,
      outputPath: OUTPUT_PATH,
    });

    expect(capturedArgs).toContain('-map');
    expect(capturedArgs).toContain('[out]');
  });

  it('dispatches on entry.type — perspective entry produces a perspective filter graph', async () => {
    const render = createFrameRenderer({ runFfmpeg: fakeRunFfmpeg, probeDuration: fakeProbeDuration });
    await render({
      inputVideo: INPUT_VIDEO,
      frameEntry: samplePerspective,
      assetsDir: ASSETS_DIR,
      backgroundColor: BG_HEX,
      outputPath: OUTPUT_PATH,
    });

    const fcIdx = capturedArgs.indexOf('-filter_complex');
    expect(fcIdx).toBeGreaterThan(-1);
    expect(capturedArgs[fcIdx + 1]).toContain('perspective=');
    // Should NOT contain the flat-specific scale option
    expect(capturedArgs[fcIdx + 1]).not.toContain('force_original_aspect_ratio');
  });

  it.skipIf(process.env.VPA_RUN_FFMPEG_TESTS !== '1')(
    'end-to-end perspective smoke test (gated by VPA_RUN_FFMPEG_TESTS=1)',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'vpa-perspective-'));
      try {
        const videoPath = join(dir, 'in.mp4');
        const framePngPath = join(dir, 'frame.png');
        const outPath = join(dir, 'out.mp4');

        // 3-second test pattern at 640x360.
        await runFfmpeg([
          '-y',
          '-f', 'lavfi',
          '-i', 'testsrc=duration=3:size=640x360:rate=24',
          videoPath,
        ]);

        // Generate a transparent PNG sized to the perspective frameSize. We use
        // `geq` to explicitly set alpha=0 because `color=...@0.0` gets clobbered
        // to opaque black when encoded as a single PNG.
        await runFfmpeg([
          '-y',
          '-f', 'lavfi',
          '-i', `nullsrc=s=${samplePerspective.frameSize.w}x${samplePerspective.frameSize.h}:d=1`,
          '-vf', 'format=rgba,geq=r=0:g=0:b=0:a=0',
          '-frames:v', '1',
          '-update', '1',
          framePngPath,
        ]);

        // The renderer reads the frame PNG at <assetsDir>/<frameEntry.frame>.
        // Use the temp dir as assetsDir and set the entry's `frame` to the bare
        // PNG filename so the join lands on our fake PNG.
        const entry: PerspectiveFrame = {
          ...samplePerspective,
          frame: 'frame.png',
        };

        const render = createFrameRenderer();
        await render({
          inputVideo: videoPath,
          frameEntry: entry,
          assetsDir: dir,
          backgroundColor: BG_HEX,
          outputPath: outPath,
        });

        const s = await stat(outPath);
        expect(s.size).toBeGreaterThan(0);
        const dur = await probeDuration(outPath);
        // Output should be roughly 3s — allow some encoder slack.
        expect(dur).toBeGreaterThan(2.5);
        expect(dur).toBeLessThan(3.5);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
