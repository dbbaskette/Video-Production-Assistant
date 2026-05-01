import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { LowerThird } from '@vpa/shared';
import { projectFiles } from '../project/paths.js';
import { probeVideo } from '../recording/metadata.js';

const execFileAsync = promisify(execFile);

export interface OverlayRenderInput {
  projectPath: string;
  sceneId: string;
  recordingPath: string;   // absolute path to the MP4
  lowerThirds: LowerThird[];
}

export interface OverlayRenderResult {
  outputPath: string;     // relative: overlays/scene-01-lower-thirds.mp4
  durationSec: number;
}

/**
 * Escape special characters for ffmpeg drawtext filter values.
 * The drawtext filter requires escaping of : ; ' \ and other chars.
 */
function escapeDrawtext(text: string): string {
  return text
    .replace(/\\/g, '\\\\\\\\')
    .replace(/'/g, "'\\\\\\''")
    .replace(/:/g, '\\:')
    .replace(/;/g, '\\;')
    .replace(/%/g, '%%');
}

/**
 * Build a drawtext filter string for a single lower-third entry.
 */
function buildDrawtextFilter(lt: LowerThird): string[] {
  const filters: string[] = [];
  const escapedTitle = escapeDrawtext(lt.title);
  const enable = `enable='between(t,${lt.in_sec},${lt.out_sec})'`;

  let styleArgs: string;
  switch (lt.style) {
    case 'frosted':
      styleArgs = 'fontcolor=white:box=1:boxcolor=black@0.5:boxborderw=8';
      break;
    case 'solid':
      styleArgs = 'fontcolor=white:box=1:boxcolor=black@0.85:boxborderw=8';
      break;
    case 'minimal':
      styleArgs = 'fontcolor=white:shadowx=2:shadowy=2:shadowcolor=black@0.7';
      break;
  }

  // Title text: bottom-left
  filters.push(
    `drawtext=text='${escapedTitle}':fontsize=28:x=40:y=h-100:${styleArgs}:${enable}`,
  );

  // Subtitle text below the title (if present)
  if (lt.subtitle) {
    const escapedSubtitle = escapeDrawtext(lt.subtitle);
    filters.push(
      `drawtext=text='${escapedSubtitle}':fontsize=20:x=40:y=h-70:${styleArgs}:${enable}`,
    );
  }

  return filters;
}

/**
 * Render lower-thirds overlays onto a recording video using ffmpeg drawtext filters.
 */
export async function renderLowerThirdsOverlay(
  input: OverlayRenderInput,
): Promise<OverlayRenderResult> {
  const { projectPath, sceneId, recordingPath, lowerThirds } = input;
  const files = projectFiles(projectPath);

  // 1. Create the overlays directory
  await mkdir(files.overlaysDir, { recursive: true });

  // 2. Build the filter chain
  const allFilters = lowerThirds.flatMap((lt) => buildDrawtextFilter(lt));
  const filterChain = allFilters.join(',');

  // 3. Determine output path
  const outputFilename = `${sceneId}-lower-thirds.mp4`;
  const outputAbsolute = join(files.overlaysDir, outputFilename);
  const outputRelative = `overlays/${outputFilename}`;

  // 4. Run ffmpeg
  const args = [
    '-y',
    '-i', recordingPath,
    '-vf', filterChain,
    '-c:a', 'copy',
    outputAbsolute,
  ];

  await execFileAsync('ffmpeg', args);

  // 5. Probe the output to get duration
  const metadata = await probeVideo(outputAbsolute);

  return {
    outputPath: outputRelative,
    durationSec: metadata.duration_sec,
  };
}

/**
 * Create a fake overlay renderer for testing.
 * Skips ffmpeg and just copies the input file to the overlay path.
 */
export function createFakeOverlayRenderer(): typeof renderLowerThirdsOverlay {
  return async (input: OverlayRenderInput): Promise<OverlayRenderResult> => {
    const { projectPath, sceneId, recordingPath } = input;
    const files = projectFiles(projectPath);

    await mkdir(files.overlaysDir, { recursive: true });

    const outputFilename = `${sceneId}-lower-thirds.mp4`;
    const outputAbsolute = join(files.overlaysDir, outputFilename);
    const outputRelative = `overlays/${outputFilename}`;

    await copyFile(recordingPath, outputAbsolute);

    return {
      outputPath: outputRelative,
      durationSec: 47.2,
    };
  };
}
