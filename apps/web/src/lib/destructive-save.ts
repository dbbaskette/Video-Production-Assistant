/**
 * Destructive-save guard.
 *
 * Several scene mutations silently invalidate downstream artifacts:
 *   • saving a script wipes the active mode's TTS chunks, audio, subtitles, timings
 *   • saving lower-thirds deletes the baked overlay video and the framed video
 *   • replacing a recording invalidates everything downstream of it
 *
 * The README documents this — the UI didn't. This module computes a concrete
 * preview of what would be discarded from the current scene state and presents
 * a confirm dialog before the mutation fires. Pure client-side: the storyboard
 * is already in the React Query cache, so no server roundtrip is needed.
 *
 * Usage:
 *   const ok = await confirmDestructiveSave(ui, {
 *     scope: 'script',
 *     scene,
 *     slot: 'monologue',
 *   });
 *   if (!ok) return;
 *   saveMutation.mutate(value);
 */

import type { Scene } from '@vpa/shared';
import type { UiApi } from '../components/ui/UiProvider.js';

export type DestructiveSaveScope = 'script' | 'lower-thirds' | 'recording';

export interface ScriptDiscard {
  chunks: number;
  audioMs: number;
  subtitles: boolean;
  timings: number;
}

export interface LowerThirdsDiscard {
  overlayRender: boolean;
  frameRender: boolean;
}

export interface RecordingDiscard {
  chunks: number;
  audioMs: number;
  overlayRender: boolean;
  frameRender: boolean;
}

/**
 * What gets wiped when saving a script. Mirrors the server-side behavior in
 * routes/narration.ts and routes/scripts.ts — the active mode's `chunks`,
 * `audio`, `subtitles`, and `timings` are cleared.
 *
 * When `slot` differs from the current mode the server preserves the active
 * mode's audio (only updates the per-mode slot's text), so the discard is
 * empty.
 */
export function computeScriptSaveDiscard(
  scene: Scene,
  slot: 'monologue' | 'dialog' = 'monologue',
): ScriptDiscard {
  const n = scene.narration;
  if (!n) return { chunks: 0, audioMs: 0, subtitles: false, timings: 0 };

  const currentMode = n.mode ?? 'monologue';
  if (slot !== currentMode) {
    return { chunks: 0, audioMs: 0, subtitles: false, timings: 0 };
  }

  const chunks = n.chunks?.length ?? 0;
  const audioMs = (n.chunks ?? []).reduce(
    (sum, c) => sum + (c.durationSec ? Math.round(c.durationSec * 1000) : 0),
    0,
  );
  const subtitles = !!(n.subtitles?.srt || n.subtitles?.vtt);
  const timings = n.timings?.length ?? 0;
  return { chunks, audioMs, subtitles, timings };
}

export function computeLowerThirdsSaveDiscard(scene: Scene): LowerThirdsDiscard {
  return {
    overlayRender: !!scene.overlay_render,
    frameRender: !!scene.frame_render,
  };
}

export function computeRecordingReplaceDiscard(scene: Scene): RecordingDiscard {
  const n = scene.narration;
  const chunks = n?.chunks?.length ?? 0;
  const audioMs = (n?.chunks ?? []).reduce(
    (sum, c) => sum + (c.durationSec ? Math.round(c.durationSec * 1000) : 0),
    0,
  );
  return {
    chunks,
    audioMs,
    overlayRender: !!scene.overlay_render,
    frameRender: !!scene.frame_render,
  };
}

function formatDuration(ms: number): string {
  if (ms <= 0) return '0s';
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}m ${s}s`;
}

function scriptDiscardSummary(d: ScriptDiscard): string[] {
  const lines: string[] = [];
  if (d.chunks > 0) {
    const audio = d.audioMs > 0 ? ` (~${formatDuration(d.audioMs)} of audio)` : '';
    lines.push(`${d.chunks} TTS chunk${d.chunks === 1 ? '' : 's'}${audio}`);
  }
  if (d.subtitles) lines.push('subtitle tracks (SRT/VTT)');
  if (d.timings > 0) lines.push(`${d.timings} word-level timing${d.timings === 1 ? '' : 's'}`);
  return lines;
}

function lowerThirdsDiscardSummary(d: LowerThirdsDiscard): string[] {
  const lines: string[] = [];
  if (d.overlayRender) lines.push('the baked overlay video');
  if (d.frameRender) lines.push('the framed video');
  return lines;
}

function recordingDiscardSummary(d: RecordingDiscard): string[] {
  const lines = scriptDiscardSummary({
    chunks: d.chunks,
    audioMs: d.audioMs,
    subtitles: false,
    timings: 0,
  });
  if (d.overlayRender) lines.push('the baked overlay video');
  if (d.frameRender) lines.push('the framed video');
  return lines;
}

export interface ConfirmDestructiveSaveArgs {
  scope: DestructiveSaveScope;
  scene: Scene;
  /** For script saves — defaults to the scene's current mode. */
  slot?: 'monologue' | 'dialog';
}

/**
 * Returns true if the user wants to proceed, false if cancelled. Returns
 * true immediately (no dialog) when nothing would be discarded.
 */
export async function confirmDestructiveSave(
  ui: UiApi,
  args: ConfirmDestructiveSaveArgs,
): Promise<boolean> {
  const lines = describeDiscard(args);
  if (lines.length === 0) return true;

  const title =
    args.scope === 'script'
      ? 'Saving this script will discard:'
      : args.scope === 'lower-thirds'
        ? 'Saving lower thirds will discard:'
        : 'Replacing this recording will discard:';

  const body = lines.map((l) => `• ${l}`).join('\n');
  return ui.confirm({
    title,
    body,
    confirmLabel: 'Continue',
    cancelLabel: 'Cancel',
    destructive: true,
  });
}

function describeDiscard(args: ConfirmDestructiveSaveArgs): string[] {
  if (args.scope === 'script') {
    return scriptDiscardSummary(computeScriptSaveDiscard(args.scene, args.slot));
  }
  if (args.scope === 'lower-thirds') {
    return lowerThirdsDiscardSummary(computeLowerThirdsSaveDiscard(args.scene));
  }
  return recordingDiscardSummary(computeRecordingReplaceDiscard(args.scene));
}
