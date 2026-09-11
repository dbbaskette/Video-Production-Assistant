import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { setupApi, type SetupProbe } from '../lib/api.js';
export function renderCapabilityFailures(probes: SetupProbe[], needsText: boolean) {
  return probes.filter(
    (p) =>
      p.status === 'fail' &&
      (p.id === 'ffmpeg-present' ||
        p.id === 'ffprobe-present' ||
        (needsText && p.id === 'ffmpeg-drawtext')),
  );
}
export function useRenderCapabilities(needsText: boolean) {
  const health = useQuery({
    queryKey: ['setup-health'],
    queryFn: () => setupApi.health(),
    staleTime: 30_000,
  });
  const failures = renderCapabilityFailures(health.data?.probes ?? [], needsText);
  return {
    failures,
    error: health.isError,
    checking: health.isPending,
    blocked: failures.length > 0 || health.isError || health.isPending,
    retry: () => health.refetch(),
  };
}
export function RenderCapabilities({ state }: { state: ReturnType<typeof useRenderCapabilities> }) {
  if (state.checking) return <p role="status">Checking render dependencies…</p>;
  if (!state.blocked) return null;
  return (
    <div role="alert">
      <p>
        {state.error
          ? 'Could not check render dependencies.'
          : state.failures.map((p) => `${p.label}: ${p.message}`).join(' ')}
      </p>
      {state.failures.some((p) => p.id === 'ffmpeg-drawtext') && (
        <p>
          Text overlays need an FFmpeg build with the drawtext filter. Use Setup Health to check the
          server configuration, or disable text overlays for this export.
        </p>
      )}
      <Link to="/setup">Open Setup Health</Link>{' '}
      <button type="button" onClick={() => void state.retry()}>
        Retry check
      </button>
    </div>
  );
}
