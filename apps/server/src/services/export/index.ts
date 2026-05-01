import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { loadStoryboard } from '../storyboard/index.js';
import { projectFiles } from '../project/paths.js';
import type { Scene } from '@vpa/shared';

export interface ExportManifest {
  projectName: string;
  exportedAt: string;
  scenes: ExportSceneEntry[];
  totalFiles: number;
}

export interface ExportSceneEntry {
  sceneId: string;
  sceneName: string;
  files: string[]; // relative paths from project root
}

/**
 * Check whether a file exists on disk.
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Collect the list of asset files that exist on disk for a single scene.
 * Returns paths relative to the project root.
 */
async function collectSceneFiles(
  projectRoot: string,
  scene: Scene,
): Promise<string[]> {
  const files: string[] = [];
  const pf = projectFiles(projectRoot);

  // Recording
  if (scene.recording?.source) {
    const absPath = join(projectRoot, scene.recording.source);
    if (await fileExists(absPath)) {
      files.push(scene.recording.source);
    }
  }

  // Narration audio
  if (scene.narration?.audio) {
    const absPath = join(projectRoot, scene.narration.audio);
    if (await fileExists(absPath)) {
      files.push(scene.narration.audio);
    }
  }

  // Subtitles SRT
  if (scene.narration?.subtitles?.srt) {
    const absPath = join(projectRoot, scene.narration.subtitles.srt);
    if (await fileExists(absPath)) {
      files.push(scene.narration.subtitles.srt);
    }
  }

  // Subtitles VTT
  if (scene.narration?.subtitles?.vtt) {
    const absPath = join(projectRoot, scene.narration.subtitles.vtt);
    if (await fileExists(absPath)) {
      files.push(scene.narration.subtitles.vtt);
    }
  }

  // Overlay render
  if (scene.overlay_render) {
    const absPath = join(projectRoot, scene.overlay_render);
    if (await fileExists(absPath)) {
      files.push(scene.overlay_render);
    }
  }

  return files;
}

/**
 * Generate an export manifest listing all available assets per scene.
 */
export async function generateExportManifest(
  projectPath: string,
): Promise<ExportManifest> {
  const storyboard = await loadStoryboard(projectPath);
  if (!storyboard) {
    throw new Error('No storyboard found for this project');
  }

  const scenes: ExportSceneEntry[] = [];
  let totalFiles = 0;

  for (const scene of storyboard.scenes) {
    const files = await collectSceneFiles(projectPath, scene);
    totalFiles += files.length;
    scenes.push({
      sceneId: scene.id,
      sceneName: scene.name,
      files,
    });
  }

  return {
    projectName: storyboard.project.name,
    exportedAt: new Date().toISOString(),
    scenes,
    totalFiles,
  };
}
