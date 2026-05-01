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

  // Update storyboard with recording info
  const sb = await loadStoryboard(projectRoot);
  if (sb) {
    const updated = updateScene(sb, sceneId, {
      recording: {
        source: relativePath,
        duration_sec: metadata.duration_sec,
        ingested_at: new Date().toISOString(),
      },
    });
    await saveStoryboard(projectRoot, updated);
  }

  return { sceneId, relativePath, metadata };
}
