import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { brandsApi } from '../lib/api.js';
import { BrandCard } from '../components/BrandCard.js';

export function BrandsList() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['brands'],
    queryFn: () => brandsApi.list(),
  });

  return (
    <main className="page">
      <header style={{ marginBottom: 32, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <h1 style={{ margin: 0 }}>Brands</h1>
          <p style={{ color: 'var(--fg-muted)', fontSize: 14, margin: '4px 0 0' }}>
            Brand kits available to apply across your video projects.
          </p>
        </div>
        <Link to="/brands/new">
          <button className="btn--outline-accent">+ New Brand</button>
        </Link>
      </header>

      {isLoading && <p className="hint">Loading brands...</p>}
      {error && <p style={{ color: 'var(--danger)' }}>Failed to load brands.</p>}

      {data && (
        data.brands.length === 0 ? (
          <div className="empty-state">
            No brands yet. Create your first brand to apply consistent visual identity across video projects.
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
