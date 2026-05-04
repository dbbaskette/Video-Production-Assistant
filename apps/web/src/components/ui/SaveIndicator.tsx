import { useEffect, useRef, useState } from 'react';
import { useIsMutating } from '@tanstack/react-query';

/**
 * Lightweight save-state indicator that lives in the navbar. Observes the
 * global React Query mutation count and surfaces three states:
 *
 *   "Saving…"   — at least one mutation is in flight
 *   "✓ Saved"   — count just dropped to 0 (visible for ~2 s, then fades)
 *   (hidden)    — no recent activity
 *
 * No per-component wiring needed; every API write that goes through a
 * useMutation call (scripts, narration, brand picker, music, render
 * options, voice metadata, etc.) is automatically reflected.
 *
 * Future extension: a separate dirty-tracker context could feed an
 * "unsaved" state for in-progress edits that haven't yet hit a mutation.
 */
export function SaveIndicator() {
  const mutating = useIsMutating();
  const [visible, setVisible] = useState<'saving' | 'saved' | null>(null);
  const lastWasMutatingRef = useRef(false);
  const fadeTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (mutating > 0) {
      setVisible('saving');
      lastWasMutatingRef.current = true;
      if (fadeTimerRef.current != null) {
        window.clearTimeout(fadeTimerRef.current);
        fadeTimerRef.current = null;
      }
    } else if (lastWasMutatingRef.current) {
      // Just transitioned from mutating -> idle: show "Saved" briefly
      setVisible('saved');
      lastWasMutatingRef.current = false;
      fadeTimerRef.current = window.setTimeout(() => {
        setVisible(null);
        fadeTimerRef.current = null;
      }, 2000);
    }
    return () => {
      if (fadeTimerRef.current != null) window.clearTimeout(fadeTimerRef.current);
    };
  }, [mutating]);

  if (!visible) return null;

  return (
    <span
      role="status"
      aria-live="polite"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 10px',
        borderRadius: 4,
        fontSize: 12,
        fontWeight: 500,
        color: visible === 'saving' ? 'var(--fg-muted)' : 'var(--success)',
        background: visible === 'saving' ? 'var(--bg-elev)' : 'transparent',
        transition: 'opacity 200ms',
      }}
    >
      {visible === 'saving' ? (
        <>
          <Spinner /> Saving…
        </>
      ) : (
        '✓ Saved'
      )}
    </span>
  );
}

function Spinner() {
  return (
    <span
      style={{
        display: 'inline-block',
        width: 10,
        height: 10,
        border: '2px solid var(--border)',
        borderTopColor: 'var(--accent)',
        borderRadius: '50%',
        animation: 'spin 0.8s linear infinite',
      }}
    />
  );
}
