/**
 * Background-job tray — single dockable spot showing every running
 * server-side job for the current project.
 *
 * Long-running ops (TTS batches, renders, voice clones, music generation)
 * used to be visible only on the page that kicked them off. Switch tabs
 * and you lose progress and any final result is silently waiting for you
 * the next time you navigate back. The tray surfaces all of them, every
 * page, with a per-job collapsed/expanded view.
 *
 * Mounted once at the app root. When on a project route it scopes
 * itself to that project's jobs; on global routes (Brands, Voices,
 * Dashboard) it shows unscoped jobs only (brand extraction, etc.).
 *
 * Polls `/api/jobs?active=1` because SSE is per-job and we want a single
 * cross-job feed. Polling cadence: 2s when expanded, 5s when collapsed.
 * Cheap — the endpoint reads from an in-memory map.
 */

import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ChevronUp, ChevronDown, Activity } from 'lucide-react';
import { jobsApi } from '../lib/api.js';
import type { Job } from '@vpa/shared';

interface ProgressEvent {
  type: string;
  data?: { current?: number; total?: number; message?: string; step?: string };
}

function latestProgress(job: Job): { fraction: number | null; label: string } {
  const events = job.events ?? [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as ProgressEvent | undefined;
    if (!e) continue;
    if (e.type === 'progress' && e.data) {
      const d = e.data;
      if (typeof d.current === 'number' && typeof d.total === 'number' && d.total > 0) {
        return {
          fraction: Math.min(1, d.current / d.total),
          label: `${d.current} / ${d.total}${d.step ? ` · ${d.step}` : ''}`,
        };
      }
      if (typeof d.message === 'string') return { fraction: null, label: d.message };
      if (typeof d.step === 'string') return { fraction: null, label: d.step };
    }
  }
  return { fraction: null, label: job.status };
}

function jobTitle(job: Job): string {
  return job.meta?.label ?? job.type;
}

function JobRow({ job }: { job: Job }) {
  const { fraction, label } = latestProgress(job);
  const pct = fraction != null ? Math.round(fraction * 100) : null;
  return (
    <div
      style={{
        padding: '8px 10px',
        borderTop: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          fontSize: 12,
        }}
      >
        <span style={{ fontWeight: 600, color: 'var(--fg)' }}>{jobTitle(job)}</span>
        {pct != null && (
          <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--fg-muted)' }}>{pct}%</span>
        )}
      </div>
      <div style={{ fontSize: 11, color: 'var(--fg-muted)' }}>{label}</div>
      <div
        style={{
          height: 3,
          background: 'var(--border)',
          borderRadius: 2,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: fraction != null ? `${pct}%` : '40%',
            height: '100%',
            background: 'var(--accent)',
            transition: 'width 200ms',
            ...(fraction == null
              ? { animation: 'jobTrayIndeterminate 1.4s ease-in-out infinite' }
              : {}),
          }}
        />
      </div>
    </div>
  );
}

export function JobTray() {
  const { projectId } = useParams<{ projectId: string }>();
  const [expanded, setExpanded] = useState(false);

  const { data } = useQuery({
    queryKey: ['jobs', 'active', projectId ?? 'global'],
    queryFn: () => jobsApi.list({ active: true, projectId }),
    refetchInterval: expanded ? 2000 : 5000,
    refetchIntervalInBackground: false,
  });

  const jobs = useMemo<Job[]>(() => data?.jobs ?? [], [data]);

  // Auto-expand when a new job appears; auto-collapse when the list
  // becomes empty. Track previous count so we only trigger on changes.
  const [autoExpandedFor, setAutoExpandedFor] = useState<number>(0);
  useEffect(() => {
    if (jobs.length > autoExpandedFor) setExpanded(true);
    if (jobs.length === 0) setExpanded(false);
    setAutoExpandedFor(jobs.length);
  }, [jobs.length, autoExpandedFor]);

  if (jobs.length === 0) return null;

  return (
    <div
      role="region"
      aria-label="Background jobs"
      style={{
        position: 'fixed',
        bottom: 50, // sit above the health rail
        right: 16,
        width: expanded ? 320 : 'auto',
        background: 'var(--bg-elev)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        boxShadow: '0 6px 20px rgba(0,0,0,0.25)',
        zIndex: 60,
        overflow: 'hidden',
      }}
    >
      <button
        onClick={() => setExpanded((v) => !v)}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 10px',
          background: 'transparent',
          color: 'var(--fg)',
          border: 'none',
          cursor: 'pointer',
          fontSize: 12,
          fontWeight: 600,
        }}
      >
        <Activity size={14} color="var(--accent)" />
        <span>
          {jobs.length} running
        </span>
        <span style={{ marginLeft: 'auto', color: 'var(--fg-muted)' }}>
          {expanded ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </span>
      </button>
      {expanded && (
        <div style={{ maxHeight: 280, overflowY: 'auto' }}>
          {jobs.map((j) => (
            <JobRow key={j.id} job={j} />
          ))}
        </div>
      )}
    </div>
  );
}
