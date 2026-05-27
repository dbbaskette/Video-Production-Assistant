import { readFile } from 'node:fs/promises';
import {
  StoryboardSchema,
  type Storyboard,
  type Scene,
  type Project,
} from '@vpa/shared';
import { loadYaml, dumpYaml } from '../../lib/yaml.js';
import { atomicWriteFile } from '../../lib/fs-atomic.js';
import { projectFiles } from '../project/paths.js';
import { writeSnapshotFromCurrent, pruneSnapshots } from './snapshots.js';

export async function loadStoryboard(projectRoot: string): Promise<Storyboard | null> {
  const files = projectFiles(projectRoot);
  try {
    const text = await readFile(files.storyboard, 'utf8');
    return loadYaml(text, StoryboardSchema);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function saveStoryboard(projectRoot: string, storyboard: Storyboard): Promise<void> {
  const files = projectFiles(projectRoot);
  const validated = StoryboardSchema.parse(storyboard);
  // Snapshot the pre-write state so we can roll back. Best-effort: a
  // failure to write a backup must never block the user's save.
  try {
    await writeSnapshotFromCurrent(projectRoot);
    await pruneSnapshots(projectRoot);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[storyboard] snapshot failed (proceeding with save):', err);
  }
  await atomicWriteFile(files.storyboard, dumpYaml(validated));
}

export function createStoryboard(project: Project, scenes: Scene[]): Storyboard {
  return StoryboardSchema.parse({
    schema_version: 1,
    project: {
      id: project.id,
      name: project.name,
      created: project.created,
      objective: project.objective,
      audience: project.audience,
    },
    scenes,
  });
}

export function addScene(sb: Storyboard, scene: Scene): Storyboard {
  if (sb.scenes.some((s) => s.id === scene.id)) {
    throw new Error(`Scene with id "${scene.id}" already exists`);
  }
  return { ...sb, scenes: [...sb.scenes, scene] };
}

export function updateScene(
  sb: Storyboard,
  sceneId: string,
  patch: Partial<Scene>,
): Storyboard {
  const idx = sb.scenes.findIndex((s) => s.id === sceneId);
  if (idx < 0) throw new Error(`Scene not found: ${sceneId}`);
  const updated = { ...sb.scenes[idx]!, ...patch, id: sceneId };
  const scenes = sb.scenes.map((s, i) => (i === idx ? updated : s));
  return { ...sb, scenes };
}

export function removeScene(sb: Storyboard, sceneId: string): Storyboard {
  const scenes = sb.scenes.filter((s) => s.id !== sceneId);
  if (scenes.length === sb.scenes.length) throw new Error(`Scene not found: ${sceneId}`);
  return { ...sb, scenes };
}

export function reorderScenes(sb: Storyboard, orderedIds: string[]): Storyboard {
  const map = new Map(sb.scenes.map((s) => [s.id, s]));
  const scenes: Scene[] = [];
  for (const id of orderedIds) {
    const scene = map.get(id);
    if (!scene) throw new Error(`Scene not found in reorder list: ${id}`);
    scenes.push(scene);
  }
  if (scenes.length !== sb.scenes.length) {
    throw new Error('Reorder list must include all scene ids');
  }
  return { ...sb, scenes };
}
