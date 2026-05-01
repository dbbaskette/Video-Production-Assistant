import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, copyFile } from 'node:fs/promises';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

export interface SceneBoundary {
  start_sec: number;
  end_sec: number;
  suggested_name: string;
}

export interface SplitResult {
  sceneId: string;
  outputPath: string;  // relative path in recordings/
  start_sec: number;
  end_sec: number;
  duration_sec: number;
}

/** Use ffmpeg to split a video into segments */
export async function splitRecording(
  sourcePath: string,
  outputDir: string,
  boundaries: SceneBoundary[],
): Promise<SplitResult[]> {
  await mkdir(outputDir, { recursive: true });
  const results: SplitResult[] = [];

  for (let i = 0; i < boundaries.length; i++) {
    const b = boundaries[i]!;
    const sceneId = `scene-${String(i + 1).padStart(2, '0')}`;
    const outputFile = join(outputDir, `${sceneId}.mp4`);
    const duration = b.end_sec - b.start_sec;

    await execFileAsync('ffmpeg', [
      '-y',
      '-i', sourcePath,
      '-ss', String(b.start_sec),
      '-t', String(duration),
      '-c', 'copy',    // stream copy, no re-encoding
      '-avoid_negative_ts', 'make_zero',
      outputFile,
    ]);

    results.push({
      sceneId,
      outputPath: `recordings/${sceneId}.mp4`,
      start_sec: b.start_sec,
      end_sec: b.end_sec,
      duration_sec: duration,
    });
  }

  return results;
}

/** Fake splitter for tests - just creates empty files */
export async function createFakeSplitter(): Promise<typeof splitRecording> {
  const { writeFile } = await import('node:fs/promises');
  return async (sourcePath, outputDir, boundaries) => {
    await mkdir(outputDir, { recursive: true });
    const results: SplitResult[] = [];
    for (let i = 0; i < boundaries.length; i++) {
      const b = boundaries[i]!;
      const sceneId = `scene-${String(i + 1).padStart(2, '0')}`;
      const outputFile = join(outputDir, `${sceneId}.mp4`);
      // Copy source to simulate split
      await copyFile(sourcePath, outputFile);
      results.push({
        sceneId,
        outputPath: `recordings/${sceneId}.mp4`,
        start_sec: b.start_sec,
        end_sec: b.end_sec,
        duration_sec: b.end_sec - b.start_sec,
      });
    }
    return results;
  };
}
