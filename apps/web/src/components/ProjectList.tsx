/**
 * Dashboard project list.
 *
 * The on-disk tracker (`<VPA_HOME>/projects.json`) keeps every project that
 * has ever been created or imported, even if the user later deletes the
 * directory. The list endpoint stats each entry's path and tags missing
 * ones with `missing: true` so we can:
 *   - dim them and show "missing on disk" in place of the relative time
 *   - offer a per-row × Remove from list action
 *   - surface a prominent "Clean up N missing" banner when any are stale
 *
 * Removing here is non-destructive: it only edits the tracker JSON, never
 * touches whatever's left on the filesystem.
 */

import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { useUi } from './ui/UiProvider.js';
import type { ProjectTrackerEntry } from '@vpa/shared';

function relativeTime(iso: string | null): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const diffMs = Date.now() - t;
  const min = Math.round(diffMs / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.round(hr / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.round(d / 7);
  return `${w}w ago`;
}

interface Props {
  onOpen: (project: ProjectTrackerEntry) => void;
}

export function ProjectList({ onOpen }: Props) {
  const qc = useQueryClient();
  const ui = useUi();
  const query = useQuery({ queryKey: ['projects'], queryFn: api.listProjects });

  const pruneMutation = useMutation({
    mutationFn: () => api.pruneMissingProjects(),
    onSuccess: ({ removed }) => {
      qc.invalidateQueries({ queryKey: ['projects'] });
      ui.showToast({
        message: `Removed ${removed.length} missing project${removed.length === 1 ? '' : 's'} from the list`,
        tone: 'success',
      });
    },
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) => api.removeProjectFromTracker(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['projects'] }),
  });

  const projects = query.data?.projects ?? [];
  const sorted = useMemo(
    () => [...projects].sort((a, b) => {
      // Missing entries sink to the bottom regardless of lastOpened so
      // the still-valid ones lead.
      if (a.missing !== b.missing) return a.missing ? 1 : -1;
      const ta = a.lastOpened ? Date.parse(a.lastOpened) : 0;
      const tb = b.lastOpened ? Date.parse(b.lastOpened) : 0;
      return tb - ta;
    }),
    [projects],
  );
  const missingCount = sorted.filter((p) => p.missing).length;

  if (query.isLoading) {
    return <p style={{ color: 'var(--fg-muted)' }}>Loading projects…</p>;
  }
  if (query.isError) {
    return (
      <p style={{ color: 'var(--danger)' }}>
        Failed to load projects: {query.error instanceof Error ? query.error.message : 'unknown'}
      </p>
    );
  }
  if (projects.length === 0) {
    return <p style={{ color: 'var(--fg-muted)' }}>No projects yet.</p>;
  }

  return (
    <>
      {missingCount > 0 && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 12,
            padding: '10px 14px',
            marginBottom: 12,
            background: 'rgba(244, 168, 58, 0.08)',
            border: '1px solid rgba(244, 168, 58, 0.4)',
            borderRadius: 6,
            fontSize: 13,
          }}
        >
          <span style={{ color: 'var(--warn)' }}>
            {missingCount} project{missingCount === 1 ? '' : 's'} no longer exist on disk.
          </span>
          <button
            onClick={async () => {
              const ok = await ui.confirm({
                title: `Clean up ${missingCount} missing project${missingCount === 1 ? '' : 's'}?`,
                body: 'Removes them from this list. The filesystem isn\'t touched (and there\'s nothing left to touch).',
                confirmLabel: 'Clean up',
              });
              if (ok) pruneMutation.mutate();
            }}
            disabled={pruneMutation.isPending}
            className="primary"
            style={{ padding: '6px 14px', fontSize: 12 }}
          >
            {pruneMutation.isPending ? 'Cleaning…' : `Clean up ${missingCount}`}
          </button>
        </div>
      )}

      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {sorted.map((p) => (
          <li
            key={p.id}
            onClick={() => !p.missing && onOpen(p)}
            style={{
              background: 'var(--bg-elev)',
              border: `1px solid ${p.missing ? 'rgba(244, 168, 58, 0.3)' : 'var(--border)'}`,
              borderRadius: 6,
              padding: '10px 14px',
              marginBottom: 6,
              cursor: p.missing ? 'default' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              opacity: p.missing ? 0.65 : 1,
              gap: 12,
            }}
          >
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
                {p.name}
                {p.missing && (
                  <span
                    style={{
                      fontSize: 10,
                      padding: '2px 6px',
                      borderRadius: 3,
                      background: 'rgba(244, 168, 58, 0.15)',
                      color: 'var(--warn)',
                      border: '1px solid rgba(244, 168, 58, 0.4)',
                      fontWeight: 600,
                      textTransform: 'uppercase',
                      letterSpacing: 0.5,
                    }}
                  >
                    Missing
                  </span>
                )}
              </div>
              <div
                style={{
                  fontSize: 12,
                  color: 'var(--fg-muted)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                title={p.path}
              >
                {p.path}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
                {p.missing ? 'deleted' : relativeTime(p.lastOpened)}
              </span>
              <button
                onClick={async (e) => {
                  e.stopPropagation();
                  const ok = await ui.confirm({
                    title: `Remove "${p.name}" from the list?`,
                    body: p.missing
                      ? 'The directory is already gone. This just clears the entry.'
                      : `The project directory at ${p.path} stays on disk; only the dashboard entry is removed. You can re-import it later via "Open folder…".`,
                    confirmLabel: 'Remove',
                    destructive: true,
                  });
                  if (ok) removeMutation.mutate(p.id);
                }}
                title="Remove from list"
                style={{
                  padding: '4px 8px',
                  fontSize: 12,
                  color: 'var(--fg-muted)',
                  background: 'transparent',
                  border: '1px solid var(--border)',
                  borderRadius: 4,
                  cursor: 'pointer',
                }}
              >
                ✕
              </button>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
