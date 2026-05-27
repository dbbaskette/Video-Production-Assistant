/**
 * Persistent "Saved 3s ago" / "Saving…" / "Unsaved" indicator for page
 * headers.
 *
 * Pairs with SaveIndicator (navbar) and FieldStatus (per-field). This
 * one fills the gap between them: a per-page badge that survives long
 * enough for the user to find the confirmation after navigating away
 * from the field they edited.
 *
 * Observes React Query's mutation count. On a successful save it records
 * the timestamp and ticks every second to render "Saved 3s ago". When
 * idle and no save has occurred, it stays hidden.
 */

import { useEffect, useRef, useState } from 'react';
import { useIsMutating } from '@tanstack/react-query';
import { STATUS_COLOR } from '../../lib/palette.js';

function relative(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

export function LastSavedBadge() {
  const mutating = useIsMutating();
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const wasMutatingRef = useRef(false);
  const [, force] = useState(0);

  useEffect(() => {
    if (mutating > 0) {
      wasMutatingRef.current = true;
    } else if (wasMutatingRef.current) {
      wasMutatingRef.current = false;
      setLastSavedAt(Date.now());
    }
  }, [mutating]);

  // Tick once a second when there's a saved-at timestamp to refresh the
  // relative-time label. Cheap — no DOM work unless we render.
  useEffect(() => {
    if (lastSavedAt == null) return;
    const id = window.setInterval(() => force((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [lastSavedAt]);

  if (mutating > 0) {
    return (
      <span style={baseStyle('var(--fg-muted)')}>
        <span style={dotStyle('var(--fg-muted)', true)} />
        Saving…
      </span>
    );
  }
  if (lastSavedAt == null) return null;
  return (
    <span style={baseStyle(STATUS_COLOR.success)}>
      <span style={dotStyle(STATUS_COLOR.success, false)} />
      Saved {relative(Date.now() - lastSavedAt)}
    </span>
  );
}

function baseStyle(color: string): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 11,
    color,
    fontWeight: 500,
    padding: '2px 8px',
    borderRadius: 4,
    background: 'var(--bg-elev)',
    border: '1px solid var(--border)',
    userSelect: 'none',
  };
}

function dotStyle(color: string, pulse: boolean): React.CSSProperties {
  return {
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: color,
    animation: pulse ? 'fieldStatusPulse 1s ease-in-out infinite' : undefined,
  };
}
