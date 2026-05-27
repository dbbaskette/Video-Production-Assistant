/**
 * Snapshot history disclosure for a project.
 *
 * Lists the rolling backups of storyboard.yaml, with timestamps and
 * sizes. One click to restore — guarded by a confirm dialog that quotes
 * what's being replaced. The current state is itself snapshotted before
 * restore, so accidental rollbacks are undoable.
 *
 * Lives inside the Project Overview as an optional disclosure — most
 * users don't need it, but it's there when an edit went sideways.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { History, RotateCcw } from 'lucide-react';
import { snapshotsApi, type SnapshotInfo } from '../lib/api.js';
import { useUi } from './ui/UiProvider.js';
import { relativeTime } from '../lib/format.js';

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function SnapshotHistory({ projectId }: { projectId: string }) {
  const ui = useUi();
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['snapshots', projectId],
    queryFn: () => snapshotsApi.list(projectId),
  });

  const restoreMutation = useMutation({
    mutationFn: (snapshotId: string) => snapshotsApi.restore(projectId, snapshotId),
    onSuccess: () => {
      ui.showToast({ message: 'Snapshot restored. Refreshing project state…', tone: 'success' });
      queryClient.invalidateQueries({ queryKey: ['storyboard', projectId] });
      queryClient.invalidateQueries({ queryKey: ['snapshots', projectId] });
    },
    onError: (err) => {
      ui.showToast({
        message: 'Restore failed',
        detail: err instanceof Error ? err.message : 'unknown error',
        tone: 'error',
      });
    },
  });

  const snapshots = data?.snapshots ?? [];

  const onRestore = async (snap: SnapshotInfo) => {
    const ok = await ui.confirm({
      title: 'Restore this snapshot?',
      body:
        `The current storyboard will be replaced with the version from ${relativeTime(snap.takenAt)}.\n\n` +
        `Your current state is snapshotted first — you can undo this by restoring the new top entry.`,
      confirmLabel: 'Restore',
      destructive: true,
    });
    if (!ok) return;
    restoreMutation.mutate(snap.id);
  };

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 10,
          color: 'var(--fg-muted)',
          fontSize: 12,
        }}
      >
        <History size={14} />
        <span>Rolling backups — last {snapshots.length === 30 ? '30' : snapshots.length} saves.</span>
      </div>
      {isLoading ? (
        <div style={{ color: 'var(--fg-muted)', fontSize: 12 }}>Loading…</div>
      ) : snapshots.length === 0 ? (
        <div style={{ color: 'var(--fg-muted)', fontSize: 12 }}>
          No snapshots yet — they're created automatically on every save.
        </div>
      ) : (
        <ul
          style={{
            listStyle: 'none',
            padding: 0,
            margin: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            maxHeight: 320,
            overflowY: 'auto',
          }}
        >
          {snapshots.map((snap) => (
            <li
              key={snap.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '6px 10px',
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                fontSize: 12,
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ color: 'var(--fg)' }}>{relativeTime(snap.takenAt)}</span>
                <span style={{ color: 'var(--fg-muted)', fontSize: 10 }}>
                  {new Date(snap.takenAt).toLocaleString()} · {fmtSize(snap.sizeBytes)}
                </span>
              </div>
              <button
                onClick={() => onRestore(snap)}
                disabled={restoreMutation.isPending}
                title="Restore this snapshot"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '4px 10px',
                  background: 'var(--surface)',
                  color: 'var(--fg)',
                  border: '1px solid var(--border)',
                  borderRadius: 4,
                  cursor: restoreMutation.isPending ? 'wait' : 'pointer',
                  fontSize: 11,
                }}
              >
                <RotateCcw size={11} />
                Restore
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
