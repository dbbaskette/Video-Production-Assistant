import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { brandsApi } from '../lib/api.js';
import { BrandCard } from '../components/BrandCard.js';
import { LoadError, LoadingState } from '../components/ui/AsyncState.js';

export function BrandsList() {
  const { data, isLoading, error, isFetching, refetch } = useQuery({
    queryKey: ['brands'],
    queryFn: () => brandsApi.list(),
  });
  const connected = data?.brands.some((brand) => brand.id === 'vmware-tanzu') ?? false;

  return (
    <main className="page">
      <header style={{ marginBottom: 32, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <h1 style={{ margin: 0 }}>Tanzu Brand</h1>
          <p style={{ color: 'var(--fg-muted)', fontSize: 14, margin: '4px 0 0' }}>
            VPA uses the installed Tanzu Brand package as its source of truth.
          </p>
        </div>
      </header>

      <section className="brand-source-card" aria-label="Brand source">
        <div>
          <strong>Managed outside VPA</strong>
          <p>Tokens, logos, bumpers, provenance, and audits come from <code>tanzu-brand</code>. VPA synchronizes the installed package at startup and whenever Settings detects it.</p>
        </div>
        <span className={`brand-source-card__status${connected ? '' : ' brand-source-card__status--attention'}`}>
          {isLoading ? 'Checking…' : connected ? 'Connected' : 'Needs setup'}
        </span>
      </section>

      {isLoading && <LoadingState label="Loading brands" detail="Reading your reusable production identities." />}
      {error && <LoadError title="Brands could not be loaded" detail="No brand data was changed." onRetry={() => { void refetch(); }} retrying={isFetching} />}

      {data && (
        data.brands.length === 0 ? (
          <div className="empty-state">
            <strong>Tanzu Brand is not connected</strong>
            <span>Open Settings to let VPA detect, download, verify, and connect the shared package.</span>
            <Link className="btn--accent" to="/settings">Set up Tanzu Brand</Link>
          </div>
        ) : (
          <div className="brand-grid">
            {data.brands.map((entry) => (
              <BrandCard key={entry.id} entry={entry} isDefault={entry.id === data.default_brand_id} />
            ))}
          </div>
        )
      )}
    </main>
  );
}

export default BrandsList;
