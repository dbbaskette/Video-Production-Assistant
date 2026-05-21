import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { projectFiles } from '../project/paths.js';
import { loadStoryboard, saveStoryboard, updateScene } from '../storyboard/index.js';
import type { VideoMetadata } from './metadata.js';

export interface IngestResult {
  sceneId: string;
  relativePath: string;
  metadata: VideoMetadata;
}

export async function ingestRecording(
  projectRoot: string,
  sceneId: string,
  sourcePath: string,
  metadata: VideoMetadata,
): Promise<IngestResult> {
  const files = projectFiles(projectRoot);
  await mkdir(files.recordingsDir, { recursive: true });

  const destName = `${sceneId}.mp4`;
  const destPath = path.join(files.recordingsDir, destName);
  await copyFile(sourcePath, destPath);

  const relativePath = `recordings/${destName}`;

  // Update storyboard with recording info. We ALSO clear the cached render
  // artifacts (`overlay_render`, `frame_render`) — both are baked from the
  // recording's pixels, so a new upload invalidates them. Without this, the
  // next project-level render would happily reuse the stale baked files
  // (which still exist on disk under the old filenames) and the user would
  // see their previous recording in the final video. The next render's
  // bake-on-demand step will regenerate fresh files from the new recording.
  const sb = await loadStoryboard(projectRoot);
  if (sb) {
    const updated = updateScene(sb, sceneId, {
      recording: {
        source: relativePath,
        duration_sec: metadata.duration_sec,
        ingested_at: new Date().toISOString(),
      },
      overlay_render: undefined,
      frame_render: undefined,
    });
    await saveStoryboard(projectRoot, updated);
  }

  return { sceneId, relativePath, metadata };
}
