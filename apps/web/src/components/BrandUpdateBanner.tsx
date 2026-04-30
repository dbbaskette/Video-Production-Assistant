import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { brandsApi } from '../lib/api';

interface Props {
  projectId: string;
  brandId: string;
  appliedVersion: number;
}

export function BrandUpdateBanner({ projectId, brandId, appliedVersion }: Props) {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['brand', brandId],
    queryFn: () => brandsApi.detail(brandId),
    enabled: !!brandId,
  });

  const apply = useMutation({
    mutationFn: async (newVersion: number) => {
      // Project update endpoint — to be implemented when the project detail page lands.
      const res = await fetch(`/api/projects/${projectId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brand: { id: brandId, applied_version: newVersion } }),
      });
      if (!res.ok) throw new Error(`Apply failed: ${res.status}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project', projectId] }),
  });

  if (!data) return null;
  if (data.registry.version <= appliedVersion) return null;

  return (
    <aside className="banner banner--info">
      <span>
        <strong>{data.registry.name}</strong> was updated to v{data.registry.version}
        <span className="hint"> (project last applied v{appliedVersion})</span>
      </span>
      <button
        className="button button--primary"
        onClick={() => apply.mutate(data.registry.version)}
        disabled={apply.isPending}
      >
        {apply.isPending ? 'Applying...' : 'Apply'}
      </button>
      <button
        className="button"
        onClick={() => apply.mutate(data.registry.version)}
        disabled={apply.isPending}
      >
        Dismiss
      </button>
    </aside>
  );
}
