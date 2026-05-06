/**
 * Formatting helpers shared across the app.
 *
 * `relativeTime` was previously duplicated as `relativeTime` in
 * ProjectList and `timeAgo` in ProjectOverview, with subtly different
 * rounding (Math.round vs Math.floor) so the same elapsed time would
 * render as "1m ago" on one screen and "just now" on the other. This
 * is the single source of truth.
 */

/**
 * Render an ISO timestamp as a relative-time phrase.
 *
 * < 30 seconds: "just now"
 * < 1 hour:     "Nm ago"
 * < 24 hours:   "Nh ago"
 * < 7 days:     "Nd ago"
 * else:         "Nw ago"
 *
 * `null` / invalid / empty input renders as the em-dash.
 */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const diffMs = Date.now() - t;
  // Round-half-down via Math.floor so "3 seconds ago" doesn't round up
  // to "1m ago"; the dedicated < 30s "just now" branch covers freshness.
  if (diffMs < 30_000) return 'just now';
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  return `${weeks}w ago`;
}
