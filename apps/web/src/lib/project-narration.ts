import type { Scene } from '@vpa/shared';

export interface ProjectNarrationPreview {
  scriptedScenes: number;
  willNarrateScenes: number;
  preservedScenes: number;
  noScriptScenes: number;
}

export interface ProjectNarrationTerminalResult {
  totalScenes: number;
  generatedScenes: number;
  generatedChunks: number;
  preservedScenes: number;
  noScriptScenes: number;
  removedScenes: number;
  failedScenes: number;
  cancelled: boolean;
  failures: Array<{
    sceneId: string;
    sceneName: string;
    code: 'scene_generation_failed';
  }>;
}

function hasCurrentAudio(scene: Scene): boolean {
  return Boolean(scene.narration?.audio || scene.narration?.chunks?.some((chunk) => chunk.audio));
}

export function projectNarrationPreview(
  scenes: Scene[],
  overwrite: boolean,
): ProjectNarrationPreview {
  const scripted = scenes.filter((scene) => Boolean(scene.narration?.script?.trim()));
  const preservedScenes = overwrite ? 0 : scripted.filter(hasCurrentAudio).length;
  return {
    scriptedScenes: scripted.length,
    willNarrateScenes: scripted.length - preservedScenes,
    preservedScenes,
    noScriptScenes: scenes.length - scripted.length,
  };
}

function safeCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

export function parseProjectNarrationResult(value: unknown): ProjectNarrationTerminalResult | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const keys = [
    'totalScenes',
    'generatedScenes',
    'generatedChunks',
    'preservedScenes',
    'noScriptScenes',
    'removedScenes',
    'failedScenes',
  ] as const;
  const counts = Object.fromEntries(keys.map((key) => [key, safeCount(source[key])])) as Record<typeof keys[number], number | null>;
  if (keys.some((key) => counts[key] === null) || typeof source.cancelled !== 'boolean') return null;

  const failures = Array.isArray(source.failures)
    ? source.failures.slice(0, 20).flatMap((candidate) => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
      const failure = candidate as Record<string, unknown>;
      if (
        typeof failure.sceneId !== 'string'
        || typeof failure.sceneName !== 'string'
        || failure.code !== 'scene_generation_failed'
      ) return [];
      return [{
        sceneId: failure.sceneId,
        sceneName: failure.sceneName,
        code: 'scene_generation_failed' as const,
      }];
    })
    : [];

  return {
    totalScenes: counts.totalScenes!,
    generatedScenes: counts.generatedScenes!,
    generatedChunks: counts.generatedChunks!,
    preservedScenes: counts.preservedScenes!,
    noScriptScenes: counts.noScriptScenes!,
    removedScenes: counts.removedScenes!,
    failedScenes: counts.failedScenes!,
    cancelled: source.cancelled,
    failures,
  };
}
