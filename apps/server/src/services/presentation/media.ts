import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { runFfmpeg } from '../render/index.js';

export type FfmpegRunner = (args: string[]) => Promise<void>;

const NORMALIZE_FILTER = '[0:v]split=2[front][back];[back]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,boxblur=20:1,eq=brightness=-0.15[bg];[front]scale=1920:1080:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,format=rgba[out]';

export async function createSlideAssets(input: {
  rawPagePath: string;
  imagePath: string;
  clipPath: string;
}, run: FfmpegRunner = runFfmpeg): Promise<void> {
  await Promise.all([
    mkdir(path.dirname(input.imagePath), { recursive: true }),
    mkdir(path.dirname(input.clipPath), { recursive: true }),
  ]);
  try {
    await run([
      '-y', '-i', input.rawPagePath,
      '-filter_complex', NORMALIZE_FILTER,
      '-map', '[out]', '-frames:v', '1', input.imagePath,
    ]);
    await run([
      '-y', '-loop', '1', '-framerate', '30', '-i', input.imagePath,
      '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an',
      '-movflags', '+faststart', input.clipPath,
    ]);
  } catch (error) {
    await Promise.all([
      rm(input.imagePath, { force: true }),
      rm(input.clipPath, { force: true }),
    ]);
    throw error;
  }
}
