import type { Scene } from '@vpa/shared';
import { isFlexiblePresentationScene } from '@vpa/shared';

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

function positiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Resolve duration for this render invocation only. Persisted chunk timing is
 * deliberately ignored: narration controls length only when the caller passes
 * a positive probe from the audio file that was actually prepared/included.
 */
export function resolveRenderSceneDuration(
  scene: Scene,
  preparedAudioDuration?: number,
): SceneDurationResolution {
  if (isFlexiblePresentationScene(scene)) {
    if (positiveFinite(preparedAudioDuration)) {
      return {
        targetSec: preparedAudioDuration,
        flexible: true,
        source: 'narration',
      };
    }
    return {
      targetSec: scene.presentation_source!.hold_duration_sec,
      flexible: true,
      source: 'slide-hold',
    };
  }

  if (positiveFinite(scene.recording?.duration_sec)) {
    return {
      targetSec: scene.recording.duration_sec,
      flexible: false,
      source: 'recording',
    };
  }
  throw new RenderError('Scene recording duration is unavailable');
}
