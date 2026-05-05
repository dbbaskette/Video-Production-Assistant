/**
 * Modal-style overlay shown while a long-running generation is in flight
 * (script + auto-dialog, batch chunk narration, etc.). Blocks the page so
 * the user can't navigate away mid-generation, which previously caused the
 * stale-monologue glitch (server hadn't saved yet, refetch returned the
 * pre-generation state).
 *
 * Usage:
 *   <GenerationModal
 *     open={isPending}
 *     title="Generating script"
 *     phase="Writing dialog version…"
 *     hint="Please don't navigate away."
 *   />
 */

import type { ReactNode } from 'react';

interface Props {
  open: boolean;
  title: string;
  /** Current phase string — e.g. "Writing monologue…" / "Converting to dialog…". */
  phase?: string;
  /** Optional secondary copy under the phase line. */
  hint?: ReactNode;
  /** Optional progress fraction 0..1 to render a determinate bar. */
  progress?: number;
  /** When provided, renders a Cancel button that calls this. */
  onCancel?: () => void;
}

export function GenerationModal({ open, title, phase, hint, progress, onCancel }: Props) {
  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.7)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1100,
      }}
    >
      <div
        style={{
          background: 'var(--bg)',
          border: '1px solid var(--border)',
          borderRadius: 10,
          padding: 28,
          width: 'min(420px, 90vw)',
          textAlign: 'center',
          boxShadow: '0 20px 60px rgba(0, 0, 0, 0.6)',
        }}
      >
        <Spinner />
        <h2 style={{ margin: '16px 0 4px', fontSize: 17 }}>{title}</h2>
        {phase && (
          <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--fg-muted)' }}>{phase}</p>
        )}
        {progress !== undefined && (
          <div style={{
            margin: '14px auto 0',
            maxWidth: 280,
            height: 6,
            background: 'var(--surface)',
            borderRadius: 3,
            overflow: 'hidden',
            border: '1px solid var(--border)',
          }}>
            <div
              style={{
                height: '100%',
                width: `${Math.max(0, Math.min(progress * 100, 100))}%`,
                background: 'var(--accent)',
                transition: 'width 200ms',
              }}
            />
          </div>
        )}
        {hint && (
          <p style={{ margin: '14px 0 0', fontSize: 11, color: 'var(--fg-muted)', lineHeight: 1.5 }}>
            {hint}
          </p>
        )}
        {onCancel && (
          <div style={{ marginTop: 16 }}>
            <button
              onClick={onCancel}
              style={{
                padding: '6px 16px',
                fontSize: 12,
                background: 'transparent',
                color: 'var(--fg-muted)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                cursor: 'pointer',
              }}
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <span
      style={{
        display: 'inline-block',
        width: 28,
        height: 28,
        border: '3px solid var(--border)',
        borderTopColor: 'var(--accent)',
        borderRadius: '50%',
        animation: 'spin 0.8s linear infinite',
      }}
    />
  );
}
