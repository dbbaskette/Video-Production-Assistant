import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSlideAssets } from './media.js';

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'vpa-presentation-media-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('createSlideAssets', () => {
  it('normalizes the page image and makes a one-second silent clip', async () => {
    const rawPagePath = path.join(directory, 'raw-page.png');
    const imagePath = path.join(directory, 'nested', 'page.png');
    const clipPath = path.join(directory, 'nested', 'page.mp4');
    const calls: string[][] = [];
    await writeFile(rawPagePath, 'raw page');
    const run = async (args: string[]) => {
      calls.push(args);
      await writeFile(args.at(-1)!, 'ffmpeg output');
    };

    await createSlideAssets({ rawPagePath, imagePath, clipPath }, run);

    expect(calls).toHaveLength(2);
    expect(calls[0]!.join(' ')).toContain(
      '[0:v]split=2[front][back];[back]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,boxblur=20:1,eq=brightness=-0.15[bg];[front]scale=1920:1080:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,format=rgba[out]',
    );
    expect(calls[0]).toEqual(expect.arrayContaining(['-map', '[out]', '-frames:v', '1', imagePath]));
    expect(calls[1]).toEqual(expect.arrayContaining([
      '-loop', '1', '-framerate', '30', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', clipPath,
    ]));
  });

  it('removes outputs when image normalization fails', async () => {
    const rawPagePath = path.join(directory, 'raw-page.png');
    const imagePath = path.join(directory, 'page.png');
    const clipPath = path.join(directory, 'page.mp4');
    await writeFile(rawPagePath, 'raw page');
    const run = async (args: string[]) => {
      await writeFile(args.at(-1)!, 'partial output');
      throw new Error('ffmpeg failed');
    };

    await expect(createSlideAssets({ rawPagePath, imagePath, clipPath }, run)).rejects.toThrow('ffmpeg failed');
    await expect(access(imagePath, constants.F_OK)).rejects.toThrow();
    await expect(access(clipPath, constants.F_OK)).rejects.toThrow();
  });

  it('removes the normalized image and partial clip when clip creation fails', async () => {
    const rawPagePath = path.join(directory, 'raw-page.png');
    const imagePath = path.join(directory, 'page.png');
    const clipPath = path.join(directory, 'page.mp4');
    let calls = 0;
    await writeFile(rawPagePath, 'raw page');
    const run = async (args: string[]) => {
      calls += 1;
      await writeFile(args.at(-1)!, 'partial output');
      if (calls === 2) throw new Error('ffmpeg failed');
    };

    await expect(createSlideAssets({ rawPagePath, imagePath, clipPath }, run)).rejects.toThrow('ffmpeg failed');
    await expect(access(imagePath, constants.F_OK)).rejects.toThrow();
    await expect(access(clipPath, constants.F_OK)).rejects.toThrow();
  });
});
