import { join } from 'node:path';
import { existsSync } from 'node:fs';

/**
 * Ensure a mono MP3 of `sec` seconds of silence exists in `dir`, generating it
 * via ffmpeg's `anullsrc` if needed. Clips are cached by (rounded) duration so
 * a scene with several equal gaps only renders one file.
 *
 * The ffmpeg runner is injected so this is unit-testable and each call site can
 * pass its own `runFfmpeg`. Returns the clip path, or **null** if generation
 * fails — callers fall back to a gapless concat so a render never breaks on a
 * missing silence clip.
 */
export async function ensureSilenceClip(
  dir: string,
  sec: number,
  run: (args: string[]) => Promise<void>,
): Promise<string | null> {
  const rounded = Math.round(sec * 1000) / 1000;
  if (!(rounded > 0)) return null;
  const outPath = join(dir, `.silence-${rounded}s.mp3`);
  if (existsSync(outPath)) return outPath;
  try {
    await run([
      '-y',
      '-f', 'lavfi',
      '-i', 'anullsrc=r=44100:cl=mono',
      '-t', String(rounded),
      '-c:a', 'libmp3lame',
      '-b:a', '192k',
      outPath,
    ]);
    return existsSync(outPath) ? outPath : null;
  } catch {
    return null;
  }
}
