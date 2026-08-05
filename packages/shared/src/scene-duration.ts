import type { Scene } from './storyboard.js';

export interface EffectiveSceneDuration {
  targetSec: number | undefined;
  flexible: boolean;
  source: 'narration' | 'slide-hold' | 'recording' | 'unavailable';
}

function positiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function isFlexiblePresentationScene(scene: Scene): boolean {
  return scene.type === 'slide'
    && scene.recording?.source_kind === 'presentation'
    && scene.presentation_source !== undefined;
}

export function preparedNarrationDurationSec(scene: Scene): number | undefined {
  if (scene.narration?.audio) return undefined;
  const chunks = (scene.narration?.chunks ?? []).filter((chunk) => chunk.audio);
  if (chunks.length === 0) return undefined;

  let total = 0;
  for (const chunk of chunks) {
    if (!positiveFinite(chunk.durationSec)) return undefined;
    const gapSec = chunk.gapSec ?? 0;
    if (!Number.isFinite(gapSec) || gapSec < 0) return undefined;
    total += chunk.durationSec + gapSec;
  }
  return positiveFinite(total) ? total : undefined;
}

/** Planning/UI duration derived from persisted storyboard metadata. */
export function resolvePlannedSceneDuration(scene: Scene): EffectiveSceneDuration {
  if (isFlexiblePresentationScene(scene)) {
    const narrationDuration = preparedNarrationDurationSec(scene);
    if (narrationDuration !== undefined) {
      return { targetSec: narrationDuration, flexible: true, source: 'narration' };
    }
    return {
      targetSec: scene.presentation_source!.hold_duration_sec,
      flexible: true,
      source: 'slide-hold',
    };
  }

  const recordingDuration = scene.recording?.duration_sec;
  if (positiveFinite(recordingDuration)) {
    return { targetSec: recordingDuration, flexible: false, source: 'recording' };
  }
  return { targetSec: undefined, flexible: false, source: 'unavailable' };
}
