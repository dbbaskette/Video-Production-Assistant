import { describe, it, expect, beforeEach } from 'vitest';
import { buildFlatFilter, createFrameRenderer } from './render.js';
import type { FlatFrame } from './manifest.js';

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
});
