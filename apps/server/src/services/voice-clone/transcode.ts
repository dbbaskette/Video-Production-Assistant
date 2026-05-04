import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

const execFileAsync = promisify(execFile);

/**
 * Transcode an arbitrary audio buffer (WebM/Opus, MP3, M4A, WAV, etc.) into the
 * canonical voice-clone format: 24 kHz mono 16-bit PCM WAV.
 *
 * Returns the WAV buffer.
 */
export async function transcodeToCanonicalWav(input: Buffer, sourceExt = 'wav'): Promise<Buffer> {
  const work = join(tmpdir(), `vpa-vc-${randomUUID()}`);
  await mkdir(work, { recursive: true });
  const inPath = join(work, `in.${sourceExt.replace(/^\./, '')}`);
  const outPath = join(work, 'out.wav');
  try {
    await writeFile(inPath, input);
    await execFileAsync('ffmpeg', [
      '-y',
      '-i', inPath,
      '-ac', '1',          // mono
      '-ar', '24000',      // 24 kHz
      '-acodec', 'pcm_s16le', // 16-bit PCM
      outPath,
    ]);
    return await readFile(outPath);
  } finally {
    await rm(work, { recursive: true, force: true });
    void dirname; // silence unused import in case of edits
  }
}

/**
 * Probe an audio file path with ffprobe and return its duration in seconds, or
 * undefined if probing fails.
 */
export async function probeDuration(path: string): Promise<number | undefined> {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      path,
    ]);
    const dur = Number.parseFloat(stdout.trim());
    return Number.isFinite(dur) ? dur : undefined;
  } catch {
    return undefined;
  }
}
