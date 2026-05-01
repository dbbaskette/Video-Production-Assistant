import { useQuery } from '@tanstack/react-query';
import { useState, useMemo } from 'react';
import { brandsApi } from '../lib/api.js';
import type { BrandRegistry } from '@vpa/shared';

interface Props {
  value: { id: string; applied_version: number } | null;
  onChange: (next: { id: string; applied_version: number } | null) => void;
}

export function BrandPicker({ value, onChange }: Props) {
  const { data } = useQuery({ queryKey: ['brands'], queryFn: () => brandsApi.list() });
  const [query, setQuery] = useState('');

  const filtered = useMemo<BrandRegistry['brands']>(() => {
    if (!data) return [];
    if (!query.trim()) return data.brands;
    const q = query.toLowerCase();
    return data.brands.filter((b) => b.name.toLowerCase().includes(q) || b.id.includes(q));
  }, [data, query]);

  const selectedEntry = data?.brands.find((b) => b.id === value?.id) ?? null;

  return (
    <div className="brand-picker">
      {selectedEntry ? (
        <div className="brand-picker__current">
          <span>{selectedEntry.name}</span>
          {selectedEntry.id === data?.default_brand_id && (
            <span style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--accent)', background: 'var(--accent-bg)', padding: '2px 7px', borderRadius: 999 }}>
              Default
            </span>
          )}
          <button type="button" onClick={() => onChange(null)}>Change</button>
        </div>
      ) : (
        <>
          <input
            className="brand-picker__input"
            placeholder="Search brands..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <ul className="brand-picker__list">
            <li>
              <button type="button" className="brand-picker__option" onClick={() => onChange(null)}>
                <span style={{ color: 'var(--fg-dim)' }}>None</span>
                <span style={{ fontSize: 12, color: 'var(--fg-dim)' }}> — unbranded project</span>
              </button>
            </li>
            {filtered.map((b) => (
              <li key={b.id}>
                <button
                  type="button"
                  className="brand-picker__option"
                  onClick={() => onChange({ id: b.id, applied_version: b.version })}
                >
                  {b.name}
                  {b.id === data?.default_brand_id && (
                    <span style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--accent)', background: 'var(--accent-bg)', padding: '2px 7px', borderRadius: 999, marginLeft: 6 }}>
                      Default
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
