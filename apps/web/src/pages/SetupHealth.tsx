import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { setupApi, type SetupProbe } from '../lib/api.js';

export function SetupHealth() {
  const qc = useQueryClient();

  const healthQuery = useQuery({
    queryKey: ['setup-health'],
    queryFn: () => setupApi.health(),
    refetchOnWindowFocus: false,
  });

  const refreshMutation = useMutation({
    mutationFn: () => setupApi.health({ refresh: true }),
    onSuccess: (data) => qc.setQueryData(['setup-health'], data),
  });

  const data = healthQuery.data;

  return (
    <main className="page" style={{ maxWidth: 880 }}>
      <header style={{ marginBottom: 24 }}>
        <h1 style={{ margin: 0 }}>Setup Health</h1>
        <p style={{ color: 'var(--fg-muted)', fontSize: 14, margin: '4px 0 0' }}>
          Quick check of the dependencies VPA needs. Each row probes one thing — green is fine, yellow is degraded, red blocks a feature.
        </p>
      </header>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <button
          onClick={() => refreshMutation.mutate()}
          disabled={refreshMutation.isPending || healthQuery.isLoading}
          className="btn--accent"
          style={{ padding: '8px 16px', fontSize: 13 }}
        >
          {refreshMutation.isPending ? 'Probing…' : '↻ Re-check'}
        </button>
        {data && <Summary health={data} />}
      </div>

      {healthQuery.isLoading && <p className="hint">Probing…</p>}
      {healthQuery.error && (
        <p style={{ color: 'var(--danger)' }}>Failed to load setup health.</p>
      )}

      {data && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {data.probes.map((p) => <ProbeRow key={p.id} probe={p} />)}
        </div>
      )}
    </main>
  );
}

function Summary({ health }: { health: { probes: SetupProbe[]; allOk: boolean; allClean: boolean } }) {
  const failed = health.probes.filter((p) => p.status === 'fail').length;
  const warned = health.probes.filter((p) => p.status === 'warn').length;
  const okCount = health.probes.filter((p) => p.status === 'ok').length;
  return (
    <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
      <span style={{ color: '#9bc572' }}>● {okCount} ok</span>
      {warned > 0 && <span style={{ marginLeft: 12, color: '#f4a83a' }}>● {warned} warn</span>}
      {failed > 0 && <span style={{ marginLeft: 12, color: 'var(--danger)' }}>● {failed} fail</span>}
    </div>
  );
}

function ProbeRow({ probe }: { probe: SetupProbe }) {
  const colors: Record<SetupProbe['status'], { dot: string; bg: string; border: string }> = {
    ok: { dot: '#9bc572', bg: 'rgba(94, 138, 58, 0.06)', border: 'rgba(94, 138, 58, 0.4)' },
    warn: { dot: '#f4a83a', bg: 'rgba(244, 168, 58, 0.06)', border: 'rgba(244, 168, 58, 0.4)' },
    fail: { dot: '#c25d5d', bg: 'rgba(194, 93, 93, 0.06)', border: 'rgba(194, 93, 93, 0.5)' },
  };
  const c = colors[probe.status];
  return (
    <div
      style={{
        display: 'flex',
        gap: 12,
        padding: 14,
        background: c.bg,
        border: `1px solid ${c.border}`,
        borderRadius: 8,
      }}
    >
      <span
        aria-hidden
        style={{
          flexShrink: 0,
          width: 10,
          height: 10,
          marginTop: 6,
          borderRadius: '50%',
          background: c.dot,
        }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <strong style={{ fontSize: 14 }}>{probe.label}</strong>
          <span style={{ fontSize: 11, textTransform: 'uppercase', color: c.dot, fontWeight: 600, letterSpacing: 1 }}>
            {probe.status}
          </span>
        </div>
        <p style={{ fontSize: 13, color: 'var(--fg-muted)', margin: '4px 0 0', wordBreak: 'break-word' }}>
          {probe.message}
        </p>
        {probe.fixHint && (
          <p style={{ fontSize: 12, color: 'var(--fg)', margin: '6px 0 0', fontFamily: "'JetBrains Mono', 'Fira Code', monospace", background: 'var(--bg-elev)', padding: '4px 8px', borderRadius: 4, display: 'inline-block' }}>
            → {probe.fixHint}
          </p>
        )}
      </div>
    </div>
  );
}

export default SetupHealth;
