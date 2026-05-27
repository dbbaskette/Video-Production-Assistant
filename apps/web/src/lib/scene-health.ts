/**
 * Scene health — per-scene readiness across the four production gates.
 *
 * Used by:
 *   • HealthRail   — persistent strip at the bottom of every project page.
 *   • ActionItemsCard on ProjectOverview — the same data as a list of
 *     actionable, sorted blockers.
 *
 * Pure, derived state — no fetches, no side effects. The storyboard query
 * is already in React Query cache for every project page, so callers can
 * read it and feed it here.
 */

import type { Storyboard, Scene } from '@vpa/shared';
import { classifyFit, computeProjectWpm } from './wpm.js';

export type RecordingStatus = 'ok' | 'missing';
/** 'absent' when there's no script at all. */
export type ScriptStatus = 'absent' | 'within' | 'under' | 'short' | 'over';
export type TtsStatus = 'fresh' | 'missing';
export type RenderStatus = 'fresh' | 'missing';

export interface SceneHealth {
  recording: RecordingStatus;
  script: ScriptStatus;
  tts: TtsStatus;
  render: RenderStatus;
}

export function computeSceneHealth(scene: Scene, projectWpm: number): SceneHealth {
  const recording: RecordingStatus = scene.recording?.source ? 'ok' : 'missing';

  let script: ScriptStatus = 'absent';
  const scriptText = scene.narration?.script || scene.narration?.monologueScript;
  if (scriptText && scriptText.trim().length > 0) {
    const recDur = scene.recording?.duration_sec ?? 0;
    if (recDur > 0) {
      const words = scriptText.split(/\s+/).filter(Boolean).length;
      script = classifyFit(words, recDur, projectWpm).verdict;
    } else {
      script = 'within';
    }
  }

  const hasAudioChunks = (scene.narration?.chunks ?? []).some((c) => !!c.audio);
  const tts: TtsStatus = hasAudioChunks ? 'fresh' : 'missing';

  const render: RenderStatus = scene.overlay_render || scene.frame_render ? 'fresh' : 'missing';

  return { recording, script, tts, render };
}

// ── ActionItemsCard data (moved here from ProjectOverview) ──────────

export interface ActionItem {
  sceneId: string;
  sceneName: string;
  tab: 'Recording' | 'Script' | 'Narration' | 'Lower Thirds';
  severity: 'warn' | 'issue';
  message: string;
}

export function computeActionItems(storyboard: Storyboard): ActionItem[] {
  const items: ActionItem[] = [];
  for (const scene of storyboard.scenes) {
    const hasRecording = !!scene.recording?.source;
    const hasScript = !!(scene.narration?.script || scene.narration?.monologueScript);
    const chunks = scene.narration?.chunks ?? [];
    const hasChunks = chunks.some((c) => !!c.audio);

    if (!hasRecording) {
      items.push({
        sceneId: scene.id,
        sceneName: scene.name,
        tab: 'Recording',
        severity: 'issue',
        message: 'Upload a recording — required before script or narration.',
      });
      continue;
    }

    if (hasScript && !hasChunks) {
      items.push({
        sceneId: scene.id,
        sceneName: scene.name,
        tab: 'Narration',
        severity: 'warn',
        message: 'Script ready but TTS not generated yet.',
      });
      continue;
    }

    const recDur = scene.recording?.duration_sec ?? 0;
    if (hasChunks && recDur > 0) {
      const audioDur = chunks.reduce((sum, c) => sum + (c.durationSec ?? 0), 0);
      const overrun = audioDur - recDur;
      if (overrun > 1.0) {
        items.push({
          sceneId: scene.id,
          sceneName: scene.name,
          tab: 'Script',
          severity: 'warn',
          message: `Narration runs ${overrun.toFixed(1)}s past the recording — consider tightening the script.`,
        });
      }
    }
  }
  return items.slice(0, 5);
}

// Re-export wpm helper so callers don't have to import from two places.
export { computeProjectWpm };
