import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { setupApi, type SetupProbe } from '../lib/api.js';
import { LoadError, LoadingState } from '../components/ui/AsyncState.js';

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
  const latestProbe = data?.probes.reduce((latest, probe) => Math.max(latest, probe.ranAt), 0) ?? 0;

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
        {data && <Summary health={data} checkedAt={latestProbe} />}
      </div>

      {healthQuery.isLoading && <LoadingState label="Checking setup" detail="Probing local tools and configured providers." />}
      {healthQuery.error && !data && <LoadError title="Setup could not be checked" detail="No health result is available yet." onRetry={() => { void healthQuery.refetch(); }} retrying={healthQuery.isFetching} />}
      {refreshMutation.error && data && <LoadError title="Refresh failed" detail={`Showing the last successful result from ${formatCheckedAt(latestProbe)}.`} onRetry={() => refreshMutation.mutate()} retrying={refreshMutation.isPending} />}

      {data && <ProbeList probes={data.probes} />}
    </main>
  );
}

function ProbeList({ probes }: { probes: SetupProbe[] }) {
  const problems = probes.filter(p => p.status !== 'ok').sort((a, b) => Number(b.status === 'fail') - Number(a.status === 'fail'));
  const healthy = probes.filter(p => p.status === 'ok');
  return <div style={{ display: 'grid', gap: 8 }}>
    {problems.length ? <h2>Needs attention</h2> : <p role="status">Everything's ready — all dependency checks passed.</p>}
    {problems.map(p => <ProbeRow key={p.id} probe={p} />)}
    <details><summary>Healthy checks ({healthy.length})</summary>{healthy.map(p => <ProbeRow key={p.id} probe={p} />)}</details>
  </div>;
}

function Summary({ health, checkedAt }: { health: { probes: SetupProbe[]; allOk: boolean; allClean: boolean }; checkedAt: number }) {
  const failed = health.probes.filter((p) => p.status === 'fail').length;
  const warned = health.probes.filter((p) => p.status === 'warn').length;
  const okCount = health.probes.filter((p) => p.status === 'ok').length;
  return (
    <div style={{ fontSize: 12, color: 'var(--fg-muted)' }} aria-label={`Setup status checked ${formatCheckedAt(checkedAt)}`}>
      <span style={{ color: '#9bc572' }}>● {okCount} ok</span>
      {warned > 0 && <span style={{ marginLeft: 12, color: '#f4a83a' }}>● {warned} warn</span>}
      {failed > 0 && <span style={{ marginLeft: 12, color: 'var(--danger)' }}>● {failed} fail</span>}
      {checkedAt > 0 && <time dateTime={new Date(checkedAt).toISOString()} title={new Date(checkedAt).toLocaleString()} style={{ marginLeft: 12 }}>Checked {formatAge(checkedAt)}</time>}
    </div>
  );
}

export function formatAge(timestamp: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1_000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

function formatCheckedAt(timestamp: number): string {
  return timestamp > 0 ? new Date(timestamp).toLocaleString() : 'an unknown time';
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
