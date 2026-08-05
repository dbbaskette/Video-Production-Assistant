import type { Scene } from '@vpa/shared';
import { resolveEffectiveSceneDuration } from '@vpa/shared';

export { isFlexiblePresentationScene } from '@vpa/shared';

export interface SceneDurationResolution {
  targetSec: number;
  flexible: boolean;
  source: 'narration' | 'slide-hold' | 'recording';
}

export class RenderError extends Error {
  hint?: string;
  stderrTail?: string;
  constructor(message: string, opts: { hint?: string; stderrTail?: string } = {}) {
    super(message);
    this.name = 'RenderError';
    this.hint = opts.hint;
    this.stderrTail = opts.stderrTail;
  }
}

export function resolveSceneDuration(
  scene: Scene,
  narrationAudioDuration?: number,
): SceneDurationResolution {
  const resolution = resolveEffectiveSceneDuration(scene, narrationAudioDuration);
  if (resolution.targetSec === undefined || resolution.source === 'unavailable') {
    throw new RenderError('Scene recording duration is unavailable');
  }
  return {
    targetSec: resolution.targetSec,
    flexible: resolution.flexible,
    source: resolution.source,
  };
}
