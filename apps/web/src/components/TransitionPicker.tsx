/**
 * TransitionPicker — per-scene picker for the "out-transition" applied when
 * cutting from THIS scene to the NEXT one. Ported from the tanzu-video-pipeline
 * project's transition system; ffmpeg `xfade` does the actual work at render
 * time (see apps/server/src/services/render/index.ts).
 *
 * `cut` (or undefined) means hard concat — the original behaviour. Picking
 * anything else triggers an xfade pass for that scene boundary only.
 *
 * Hidden when the scene is the final one in the storyboard (nothing to
 * transition into).
 */

import { useEffect, useState } from 'react';

export type SceneTransition =
  | 'cut'
  | 'crossfade'
  | 'fade-black'
  | 'fade-white'
  | 'wipe-left'
  | 'wipe-right'
  | 'slide-left'
  | 'slide-right'
  | 'slide-up'
  | 'slide-down'
  | 'circleopen'
  | 'circleclose'
  | 'radial'
  | 'pixelize';

const TRANSITION_OPTIONS: { value: SceneTransition; label: string }[] = [
  { value: 'cut', label: 'Cut (no transition)' },
  { value: 'crossfade', label: 'Crossfade' },
  { value: 'fade-black', label: 'Fade to black' },
  { value: 'fade-white', label: 'Fade to white' },
  { value: 'wipe-left', label: 'Wipe left' },
  { value: 'wipe-right', label: 'Wipe right' },
  { value: 'slide-left', label: 'Slide left' },
  { value: 'slide-right', label: 'Slide right' },
  { value: 'slide-up', label: 'Slide up' },
  { value: 'slide-down', label: 'Slide down' },
  { value: 'circleopen', label: 'Circle open' },
  { value: 'circleclose', label: 'Circle close' },
  { value: 'radial', label: 'Radial' },
  { value: 'pixelize', label: 'Pixelize' },
];

interface Props {
  /** Current transition, or undefined for "cut". */
  value?: SceneTransition;
  /** Current overlap duration in seconds. Default 0.5. */
  durationSec?: number;
  /** Whether this is the last scene (in which case the picker is hidden). */
  isLastScene?: boolean;
  /** Called with the chosen transition + duration. duration is undefined when transition is cut. */
  onChange: (transition: SceneTransition, durationSec: number | undefined) => void;
  /** True while a save is in flight — disables the controls. */
  isSaving?: boolean;
}

export function TransitionPicker({ value, durationSec, isLastScene, onChange, isSaving }: Props) {
  const current = value ?? 'cut';
  // Local draft for duration so the user can type freely without each
  // keystroke triggering a save. Committed onBlur.
  const [draftDuration, setDraftDuration] = useState<string>(String(durationSec ?? 0.5));

  useEffect(() => {
    setDraftDuration(String(durationSec ?? 0.5));
  }, [durationSec]);

  if (isLastScene) {
    return null;
  }

  const showDuration = current !== 'cut';

  return (
    <div
      style={{
        padding: 14,
        background: 'var(--bg-elev)',
        border: '1px solid var(--border)',
        borderRadius: 8,
      }}
    >
      <div
        style={{
          fontSize: 11,
          color: 'var(--fg-muted)',
          textTransform: 'uppercase',
          letterSpacing: 1,
          marginBottom: 8,
          fontWeight: 600,
        }}
      >
        Transition to next scene
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <select
          value={current}
          disabled={isSaving}
          onChange={(e) => {
            const next = e.target.value as SceneTransition;
            const nextDuration = next === 'cut' ? undefined : Number(draftDuration) || 0.5;
            onChange(next, nextDuration);
          }}
          style={{
            padding: '6px 10px',
            background: 'var(--surface)',
            color: 'var(--fg)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            fontSize: 13,
            cursor: isSaving ? 'wait' : 'pointer',
            minWidth: 180,
          }}
        >
          {TRANSITION_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>

        {showDuration && (
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--fg-muted)' }}>
            Duration:
            <input
              type="number"
              min={0.1}
              max={5}
              step={0.1}
              value={draftDuration}
              disabled={isSaving}
              onChange={(e) => setDraftDuration(e.target.value)}
              onBlur={() => {
                const n = Number(draftDuration);
                if (Number.isFinite(n) && n >= 0.1 && n <= 5) {
                  if (n !== durationSec) onChange(current, n);
                } else {
                  setDraftDuration(String(durationSec ?? 0.5));
                }
              }}
              style={{
                width: 64,
                padding: '4px 6px',
                background: 'var(--surface)',
                color: 'var(--fg)',
                border: '1px solid var(--border)',
                borderRadius: 4,
                fontSize: 12,
              }}
            />
            <span>sec</span>
          </label>
        )}
      </div>
      <p style={{ fontSize: 11, color: 'var(--fg-muted)', margin: '8px 0 0', lineHeight: 1.5 }}>
        Applied at render time via ffmpeg <code>xfade</code>. Hard cut is the default and is fastest
        (no re-encode). Anything else triggers a re-encode pass for the final join.
      </p>
    </div>
  );
}
