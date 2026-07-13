import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureSilenceClip } from './silence.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'vpa-silence-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('ensureSilenceClip', () => {
  it('builds an anullsrc clip of the requested duration and returns its path', async () => {
    const calls: string[][] = [];
    const run = async (args: string[]) => {
      calls.push(args);
      // Simulate ffmpeg writing the output (last arg).
      await writeFile(args[args.length - 1]!, 'fake-mp3');
    };
    const out = await ensureSilenceClip(dir, 1.5, run);
    expect(out).not.toBeNull();
    expect(calls).toHaveLength(1);
    const args = calls[0]!.join(' ');
    expect(args).toContain('anullsrc');
    expect(args).toContain('-t 1.5');
    expect(args).toContain('libmp3lame');
  });

  it('caches by duration — a second call for the same length does not re-run', async () => {
    let runs = 0;
    const run = async (args: string[]) => {
      runs++;
      await writeFile(args[args.length - 1]!, 'fake-mp3');
    };
    await ensureSilenceClip(dir, 2, run);
    await ensureSilenceClip(dir, 2, run);
    expect(runs).toBe(1);
    // Distinct duration → a new clip.
    await ensureSilenceClip(dir, 1, run);
    expect(runs).toBe(2);
    // Only two distinct silence files exist.
    const files = (await readdir(dir)).filter((f) => f.includes('silence'));
    expect(files).toHaveLength(2);
  });

  it('returns null (never throws) when ffmpeg fails, so a render can proceed gapless', async () => {
    const run = async () => {
      throw new Error('ffmpeg boom');
    };
    const out = await ensureSilenceClip(dir, 1, run);
    expect(out).toBeNull();
  });
});
