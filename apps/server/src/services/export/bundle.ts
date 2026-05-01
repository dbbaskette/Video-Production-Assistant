import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { generateExportManifest } from './index.js';
import type { ExportManifest, ExportSceneEntry } from './index.js';

/**
 * Map a relative project file path to a human-friendly filename
 * inside the scene export directory.
 */
function friendlyName(relPath: string): string {
  if (relPath.startsWith('recordings/')) return `recording${extname(relPath)}`;
  if (relPath.endsWith('.mp3')) return 'narration.mp3';
  if (relPath.endsWith('.srt')) return 'subtitles.srt';
  if (relPath.endsWith('.vtt')) return 'subtitles.vtt';
  if (relPath.startsWith('overlays/')) return `overlay${extname(relPath)}`;
  // Fallback: use the original basename
  return relPath.split('/').pop()!;
}

/**
 * Build a scene subdirectory name like "scene-01-Introduction".
 */
function sceneDirName(index: number, sceneName: string): string {
  const order = String(index + 1).padStart(2, '0');
  const safe = sceneName
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `scene-${order}-${safe}`;
}

/**
 * Generate a human-readable README.txt for the export bundle.
 */
function buildReadme(manifest: ExportManifest): string {
  const lines: string[] = [];
  lines.push(`Export: ${manifest.projectName}`);
  lines.push(`Date:   ${manifest.exportedAt}`);
  lines.push(`Total files: ${manifest.totalFiles}`);
  lines.push('');
  lines.push('Scenes');
  lines.push('------');

  for (const scene of manifest.scenes) {
    lines.push('');
    lines.push(`  ${scene.sceneName} (${scene.sceneId})`);
    if (scene.files.length === 0) {
      lines.push('    (no assets)');
    } else {
      for (const f of scene.files) {
        lines.push(`    - ${f}`);
      }
    }
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Create an export bundle by copying all scene assets into a flat directory
 * structure organized by scene.
 *
 * Returns the path to the created export directory and the manifest.
 */
export async function exportBundle(
  projectPath: string,
  outputDir?: string,
): Promise<{ exportDir: string; manifest: ExportManifest }> {
  const manifest = await generateExportManifest(projectPath);

  // Build output directory path
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safeName = manifest.projectName
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const bundleName = `${safeName}-${timestamp}`;
  const baseDir = outputDir ?? join(projectPath, 'export');
  const exportDir = join(baseDir, bundleName);

  await mkdir(exportDir, { recursive: true });

  // Copy files for each scene
  for (let i = 0; i < manifest.scenes.length; i++) {
    const scene = manifest.scenes[i]!;
    const sceneDir = join(exportDir, sceneDirName(i, scene.sceneName));
    await mkdir(sceneDir, { recursive: true });

    for (const relPath of scene.files) {
      const srcPath = join(projectPath, relPath);
      const destPath = join(sceneDir, friendlyName(relPath));
      await copyFile(srcPath, destPath);
    }
  }

  // Write manifest.json
  await writeFile(
    join(exportDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
  );

  // Write README.txt
  await writeFile(join(exportDir, 'README.txt'), buildReadme(manifest));

  return { exportDir, manifest };
}
