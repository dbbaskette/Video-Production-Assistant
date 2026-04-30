import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api.js';
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
  const query = useQuery({ queryKey: ['projects'], queryFn: api.listProjects });

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
  const projects = query.data?.projects ?? [];
  if (projects.length === 0) {
    return <p style={{ color: 'var(--fg-muted)' }}>No projects yet.</p>;
  }
  const sorted = [...projects].sort((a, b) => {
    const ta = a.lastOpened ? Date.parse(a.lastOpened) : 0;
    const tb = b.lastOpened ? Date.parse(b.lastOpened) : 0;
    return tb - ta;
  });
  return (
    <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
      {sorted.map((p) => (
        <li
          key={p.id}
          onClick={() => onOpen(p)}
          style={{
            background: 'var(--bg-elev)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            padding: '10px 14px',
            marginBottom: 6,
            cursor: 'pointer',
            display: 'flex',
            justifyContent: 'space-between',
          }}
        >
          <div>
            <div style={{ fontWeight: 600 }}>{p.name}</div>
            <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{p.path}</div>
          </div>
          <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{relativeTime(p.lastOpened)}</div>
        </li>
      ))}
    </ul>
  );
}
