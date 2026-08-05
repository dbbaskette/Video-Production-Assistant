import type { Scene } from '@vpa/shared';

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

export function isFlexiblePresentationScene(scene: Scene): boolean {
  return scene.type === 'slide'
    && scene.recording?.source_kind === 'presentation'
    && scene.presentation_source !== undefined;
}

export function resolveSceneDuration(
  scene: Scene,
  narrationAudioDuration?: number,
): SceneDurationResolution {
  if (isFlexiblePresentationScene(scene)) {
    if (narrationAudioDuration !== undefined
      && Number.isFinite(narrationAudioDuration)
      && narrationAudioDuration > 0) {
      return { targetSec: narrationAudioDuration, flexible: true, source: 'narration' };
    }
    return {
      targetSec: scene.presentation_source!.hold_duration_sec,
      flexible: true,
      source: 'slide-hold',
    };
  }

  const recordingDuration = scene.recording?.duration_sec;
  if (recordingDuration === undefined
    || !Number.isFinite(recordingDuration)
    || recordingDuration <= 0) {
    throw new RenderError('Scene recording duration is unavailable');
  }

  return { targetSec: recordingDuration, flexible: false, source: 'recording' };
}
