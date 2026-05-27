import path from 'node:path';

export function resolveProjectRoot(parentDir: string, name: string): string {
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new Error(`Invalid project name "${name}": contains path separator or ..`);
  }
  return path.join(parentDir, name);
}

export interface ProjectFiles {
  root: string;
  metadata: string; // project.yaml
  storyboard: string; // storyboard.yaml
  state: string; // state.yaml
  recordingsDir: string;
  narrationDir: string;
  overlaysDir: string;
  sourceDocsDir: string;
  /** Rolling backups of storyboard.yaml, one per save. Pruned after 30. */
  snapshotsDir: string;
}

export function projectFiles(root: string): ProjectFiles {
  return {
    root,
    metadata: path.join(root, 'project.yaml'),
    storyboard: path.join(root, 'storyboard.yaml'),
    state: path.join(root, 'state.yaml'),
    recordingsDir: path.join(root, 'recordings'),
    narrationDir: path.join(root, 'narration'),
    overlaysDir: path.join(root, 'overlays'),
    sourceDocsDir: path.join(root, 'source-docs'),
    snapshotsDir: path.join(root, '.snapshots'),
  };
}

export function trackerPath(vpaHome: string): string {
  return path.join(vpaHome, 'projects.json');
}
