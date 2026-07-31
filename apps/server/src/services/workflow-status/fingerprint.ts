import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { Project, Storyboard } from '@vpa/shared';

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !['overlay_render', 'frame_render', 'review', 'shot_plan', 'shot_plan_chat'].includes(key))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, stable(child)]),
    );
  }
  return value;
}

async function fileIdentity(projectPath: string, path: string | undefined) {
  if (!path) return null;
  const absolute = isAbsolute(path) ? path : join(projectPath, path);
  try {
    const info = await stat(absolute);
    return { path, size: info.size, modifiedMs: Math.trunc(info.mtimeMs) };
  } catch {
    return { path, missing: true };
  }
}

export async function buildRenderFingerprint(
  projectPath: string,
  project: Project,
  storyboard: Storyboard | null,
  renderOptions: unknown = {},
): Promise<string> {
  const scenes = await Promise.all((storyboard?.scenes ?? []).map(async (scene) => ({
    scene: stable(scene),
    recording: await fileIdentity(projectPath, scene.recording?.source),
    narration: await fileIdentity(projectPath, scene.narration?.audio),
    chunks: await Promise.all((scene.narration?.chunks ?? []).map((chunk) => fileIdentity(projectPath, chunk.audio))),
  })));
  const payload = stable({
    project: { id: project.id, brand: project.brand },
    defaults: storyboard?.defaults,
    scenes,
    renderOptions,
  });
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function buildReviewFingerprint(storyboard: Storyboard | null): string {
  const payload = stable({ project: storyboard?.project, defaults: storyboard?.defaults, scenes: storyboard?.scenes });
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}
