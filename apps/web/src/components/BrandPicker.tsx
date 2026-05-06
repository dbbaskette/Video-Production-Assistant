import { useQuery } from '@tanstack/react-query';
import { useState, useMemo } from 'react';
import { brandsApi } from '../lib/api.js';
import type { BrandRegistry } from '@vpa/shared';

interface Props {
  value: { id: string; applied_version: number } | null;
  onChange: (next: { id: string; applied_version: number } | null) => void;
}

/**
 * Brand picker — closed by default to keep the dialog compact.
 *
 * The previous version always rendered an `<input>` + 200-px scrollable
 * `<ul>` of every brand inline, which inside `NewProjectDialog` pushed
 * the Reference Docs section + Create button below the fold for users
 * with more than ~3 brands. Now selection collapses to a single line
 * (current brand or "None"), and a Change button reveals the search +
 * list only on demand.
 */
export function BrandPicker({ value, onChange }: Props) {
  const { data } = useQuery({ queryKey: ['brands'], queryFn: () => brandsApi.list() });
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState(false);

  const filtered = useMemo<BrandRegistry['brands']>(() => {
    if (!data) return [];
    if (!query.trim()) return data.brands;
    const q = query.toLowerCase();
    return data.brands.filter((b) => b.name.toLowerCase().includes(q) || b.id.includes(q));
  }, [data, query]);

  const selectedEntry = data?.brands.find((b) => b.id === value?.id) ?? null;

  // Collapsed view — current selection + a Change button. This is what
  // the dialog renders most of the time.
  if (!expanded) {
    return (
      <div className="brand-picker">
        <div className="brand-picker__current">
          {selectedEntry ? (
            <>
              <span>{selectedEntry.name}</span>
              {selectedEntry.id === data?.default_brand_id && (
                <span style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--accent)', background: 'var(--accent-bg)', padding: '2px 7px', borderRadius: 999 }}>
                  Default
                </span>
              )}
            </>
          ) : (
            <span style={{ color: 'var(--fg-muted)', fontSize: 13 }}>None — unbranded project</span>
          )}
          <button type="button" onClick={() => setExpanded(true)} style={{ marginLeft: 'auto' }}>
            {selectedEntry ? 'Change' : 'Pick brand'}
          </button>
        </div>
      </div>
    );
  }

  // Expanded — search + list. Same content as before; just gated.
  return (
    <div className="brand-picker">
      <input
        className="brand-picker__input"
        placeholder="Search brands…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoFocus
      />
      <ul
        className="brand-picker__list"
        style={{ maxHeight: 180, overflowY: 'auto' }}
      >
        <li>
          <button
            type="button"
            className="brand-picker__option"
            onClick={() => {
              onChange(null);
              setExpanded(false);
              setQuery('');
            }}
          >
            <span style={{ color: 'var(--fg-dim)' }}>None</span>
            <span style={{ fontSize: 12, color: 'var(--fg-dim)' }}> — unbranded project</span>
          </button>
        </li>
        {filtered.map((b) => (
          <li key={b.id}>
            <button
              type="button"
              className="brand-picker__option"
              onClick={() => {
                onChange({ id: b.id, applied_version: b.version });
                setExpanded(false);
                setQuery('');
              }}
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
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 6 }}>
        <button type="button" onClick={() => setExpanded(false)} style={{ fontSize: 12 }}>
          Cancel
        </button>
      </div>
    </div>
  );
}
