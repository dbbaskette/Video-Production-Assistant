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

export type GenerationStepStatus = 'done' | 'failed' | 'active' | 'queued';
export interface GenerationStep {
  status: GenerationStepStatus;
  /** Short label shown inside / under the dot. Defaults to 1-based index. */
  label?: string;
}

interface Props {
  open: boolean;
  title: string;
  /** Current phase string — e.g. "Writing monologue…" / "Converting to dialog…". */
  phase?: string;
  /** Optional secondary copy under the phase line. */
  hint?: ReactNode;
  /** Optional progress fraction 0..1 to render a determinate bar. */
  progress?: number;
  /** Optional per-step grid (e.g. one dot per narration chunk). When
   *  present, renders a small row of color-coded chips below the bar
   *  that tick over from queued → active → done as work lands. */
  steps?: GenerationStep[];
  /** When provided, renders a Cancel button that calls this. */
  onCancel?: () => void;
}

export function GenerationModal({ open, title, phase, hint, progress, steps, onCancel }: Props) {
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
        {steps && steps.length > 0 && (
          <div
            aria-hidden
            style={{
              margin: '12px auto 0',
              maxWidth: 320,
              display: 'flex',
              gap: 4,
              flexWrap: 'wrap',
              justifyContent: 'center',
            }}
          >
            {steps.map((step, i) => (
              <span key={i} style={stepDotStyle(step.status)} title={`${step.label ?? i + 1} — ${step.status}`}>
                {step.status === 'done' ? '✓' : step.status === 'failed' ? '×' : (step.label ?? i + 1)}
              </span>
            ))}
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

function stepDotStyle(status: GenerationStepStatus): React.CSSProperties {
  const base: React.CSSProperties = {
    minWidth: 22,
    height: 22,
    padding: '0 6px',
    borderRadius: 11,
    fontSize: 10,
    fontWeight: 600,
    fontFamily: "'JetBrains Mono', 'Fira Code', ui-monospace, monospace",
    fontVariantNumeric: 'tabular-nums',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: '1px solid var(--border)',
    transition: 'background 240ms, color 240ms, border-color 240ms, transform 240ms',
  };
  switch (status) {
    case 'done':
      return { ...base, background: 'var(--success)', color: '#0a0a0c', borderColor: 'var(--success)' };
    case 'failed':
      return { ...base, background: 'transparent', color: 'var(--danger)', borderColor: 'var(--danger)' };
    case 'active':
      return {
        ...base,
        background: 'var(--accent-bg)',
        color: 'var(--accent)',
        borderColor: 'var(--accent)',
        animation: 'pulse-glow 1.4s ease-in-out infinite',
      };
    case 'queued':
    default:
      return { ...base, background: 'transparent', color: 'var(--fg-muted)', opacity: 0.55 };
  }
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
