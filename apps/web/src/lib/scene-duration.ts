import {
  isFlexiblePresentationScene,
  resolveEffectiveSceneDuration,
  type Scene,
} from '@vpa/shared';

function formatHumanDuration(sec: number): string {
  const minutes = Math.floor(sec / 60);
  const seconds = Math.round(sec % 60);
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function formatClockDuration(sec: number): string {
  const minutes = Math.floor(sec / 60);
  const seconds = Math.round(sec % 60);
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function hasNarrationAudio(scene: Scene): boolean {
  return !!scene.narration?.audio
    || (scene.narration?.chunks?.some((chunk) => !!chunk.audio) ?? false);
}

function presentationDurationLabel(scene: Scene): string {
  const duration = resolveEffectiveSceneDuration(scene);
  return hasNarrationAudio(scene)
    ? 'Narration sets final length'
    : `${formatHumanDuration(duration.targetSec!)} hold without narration`;
}

export function recordingInfoDurationLabel(
  scene: Scene | undefined,
  fallbackDurationSec?: number,
): string | null {
  if (scene && isFlexiblePresentationScene(scene)) return presentationDurationLabel(scene);
  const durationSec = scene?.recording?.duration_sec ?? fallbackDurationSec;
  return durationSec === undefined ? null : formatHumanDuration(durationSec);
}

export function recordingsDurationLabel(scene: Scene): string | null {
  if (isFlexiblePresentationScene(scene)) return presentationDurationLabel(scene);
  const durationSec = scene.recording?.duration_sec;
  return durationSec === undefined ? null : formatClockDuration(durationSec);
}

export function lowerThirdTimelineDurationSec(scene: Scene | undefined): number | undefined {
  if (!scene) return undefined;
  return resolveEffectiveSceneDuration(scene).targetSec;
}

export type ScriptDurationGuidance =
  | { mode: 'flexible'; label: 'Narration sets final length' }
  | { mode: 'fixed'; durationSec: number }
  | { mode: 'unavailable' };

export function scriptDurationGuidance(scene: Scene | undefined): ScriptDurationGuidance {
  if (!scene) return { mode: 'unavailable' };
  const duration = resolveEffectiveSceneDuration(scene);
  if (duration.flexible) return { mode: 'flexible', label: 'Narration sets final length' };
  return duration.targetSec === undefined
    ? { mode: 'unavailable' }
    : { mode: 'fixed', durationSec: duration.targetSec };
}
