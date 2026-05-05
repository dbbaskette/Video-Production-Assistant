/**
 * Tiny per-field save-state pip.
 *
 * Existed because the app has at least four different save semantics on
 * one ScenePage — scene-intent saves on blur, speaker-config saves on
 * generate, chunk-speaker saves immediately, monologue script needs an
 * explicit Save button — with no visible signal which is which. With this
 * component a user looking at any field knows whether their input is
 * persisted, in flight, or dirty.
 *
 * Usage:
 *   <FieldStatus state="dirty" />
 *   <FieldStatus state="saving" />
 *   <FieldStatus state="saved" />
 *   <FieldStatus state="error" detail="permission denied" />
 *   <FieldStatus state="idle" />   // renders nothing
 *
 * The `state` is derived by the parent component from its mutation:
 *   const state =
 *     mutation.isPending ? 'saving' :
 *     mutation.isError ? 'error' :
 *     dirty ? 'dirty' :
 *     mutation.isSuccess ? 'saved' :
 *     'idle';
 */

import { STATUS_COLOR, FORM_SIZE } from '../../lib/palette.js';

export type FieldSaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

interface Props {
  state: FieldSaveState;
  /** Optional detail text shown after the label, e.g. error message. */
  detail?: string;
  /** Override the color (rare — usually derived from state). */
  className?: string;
}

const LABEL: Record<FieldSaveState, string> = {
  idle: '',
  dirty: 'Unsaved',
  saving: 'Saving…',
  saved: 'Saved',
  error: 'Save failed',
};

const COLOR: Record<FieldSaveState, string> = {
  idle: STATUS_COLOR.muted,
  dirty: STATUS_COLOR.warn,
  saving: STATUS_COLOR.muted,
  saved: STATUS_COLOR.success,
  error: STATUS_COLOR.danger,
};

export function FieldStatus({ state, detail, className }: Props) {
  if (state === 'idle') return null;
  return (
    <span
      className={className}
      style={{
        fontSize: FORM_SIZE.helperPx,
        color: COLOR[state],
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        userSelect: 'none',
      }}
      aria-live="polite"
    >
      <span
        aria-hidden
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: COLOR[state],
          // Pulse during in-flight saves so it's clearly "doing something".
          animation: state === 'saving' ? 'fieldStatusPulse 1s ease-in-out infinite' : undefined,
        }}
      />
      {LABEL[state]}
      {detail && state === 'error' ? `: ${detail}` : null}
    </span>
  );
}
