/**
 * CommandPalette — Cmd+K (or Ctrl+K) opens a fuzzy-search overlay that
 * jumps to any project / brand / voice / scene of the current project /
 * fixed top-level route. Closes on Escape or click-outside.
 *
 * No external deps — fuzzy match is a small case-insensitive subsequence
 * scorer that's plenty for ~200 items, which is the realistic ceiling
 * for this tool.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, brandsApi, storyboardApi, voiceCloneApi } from '../../lib/api.js';

interface PaletteItem {
  id: string;
  label: string;
  /** Secondary line in muted text (e.g. "Brand", "Voice clone", "Scene · test6"). */
  hint?: string;
  /** Path to navigate to on selection. */
  to: string;
  /** Group label shown when no query is active. */
  group: 'Projects' | 'Scenes' | 'Brands' | 'Voices' | 'Pages';
}

/** Compute a fuzzy-match score against a query — higher is better. Returns 0
 * when the query doesn't match. Tuned to be cheap, not perfect. */
function fuzzyScore(label: string, query: string): number {
  if (query.length === 0) return 1;
  const haystack = label.toLowerCase();
  const needle = query.toLowerCase();
  let i = 0;
  let score = 0;
  let lastMatch = -1;
  for (const c of needle) {
    const idx = haystack.indexOf(c, i);
    if (idx === -1) return 0;
    // Bigger reward when the match is contiguous with the last one
    score += idx === lastMatch + 1 ? 5 : 1;
    // Word-start bonus
    if (idx === 0 || haystack[idx - 1] === ' ' || haystack[idx - 1] === '-') score += 2;
    lastMatch = idx;
    i = idx + 1;
  }
  // Shorter labels rank higher when the score ties
  return score - haystack.length * 0.01;
}

const FIXED_PAGES: PaletteItem[] = [
  { id: 'page:dashboard', label: 'Dashboard', to: '/', group: 'Pages' },
  { id: 'page:brands', label: 'Brands', to: '/brands', group: 'Pages' },
  { id: 'page:brand-new', label: 'New brand', to: '/brands/new', group: 'Pages' },
  { id: 'page:voices', label: 'Voice clones', to: '/voices', group: 'Pages' },
  { id: 'page:voice-new', label: 'New voice', to: '/voices/new', group: 'Pages' },
  { id: 'page:setup', label: 'Setup health', to: '/setup', group: 'Pages' },
  { id: 'page:settings', label: 'Settings', to: '/settings', group: 'Pages' },
];

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Bind Cmd+K / Ctrl+K to toggle the palette
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === 'Escape' && open) {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // When the palette opens, focus the input and reset state
  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIndex(0);
      const t = window.setTimeout(() => inputRef.current?.focus(), 30);
      return () => window.clearTimeout(t);
    }
  }, [open]);

  // ── Data sources — only fetch while the palette is open ────────────
  const { projectId } = useParams<{ projectId: string }>();

  const projectsQuery = useQuery({
    queryKey: ['palette', 'projects'],
    queryFn: () => api.listProjects(),
    enabled: open,
  });
  const brandsQuery = useQuery({
    queryKey: ['palette', 'brands'],
    queryFn: () => brandsApi.list(),
    enabled: open,
  });
  const voicesQuery = useQuery({
    queryKey: ['palette', 'voices'],
    queryFn: () => voiceCloneApi.list(),
    enabled: open,
  });
  const storyboardQuery = useQuery({
    queryKey: ['palette', 'storyboard', projectId],
    queryFn: () => storyboardApi.get(projectId!),
    enabled: open && !!projectId,
  });

  const items = useMemo<PaletteItem[]>(() => {
    const out: PaletteItem[] = [];
    // Scenes — only when inside a project
    if (storyboardQuery.data?.scenes) {
      for (const s of storyboardQuery.data.scenes) {
        out.push({
          id: `scene:${s.id}`,
          label: s.name,
          hint: 'Scene',
          to: `/project/${projectId}/storyboard?scene=${encodeURIComponent(s.id)}`,
          group: 'Scenes',
        });
      }
    }
    // Projects
    if (projectsQuery.data?.projects) {
      for (const p of projectsQuery.data.projects) {
        out.push({
          id: `project:${p.id}`,
          label: p.name,
          hint: p.path,
          to: `/project/${p.id}`,
          group: 'Projects',
        });
      }
    }
    // Brands
    if (brandsQuery.data?.brands) {
      for (const b of brandsQuery.data.brands) {
        out.push({
          id: `brand:${b.id}`,
          label: b.name,
          hint: b.id === brandsQuery.data?.default_brand_id ? 'Brand · default' : 'Brand',
          to: `/brands/${b.id}`,
          group: 'Brands',
        });
      }
    }
    // Voice clones
    if (voicesQuery.data) {
      for (const v of voicesQuery.data) {
        out.push({
          id: `voice:${v.id}`,
          label: v.name,
          hint: v.providers.xai ? 'Voice · xAI' : 'Voice clone',
          to: `/voices/${encodeURIComponent(v.id)}`,
          group: 'Voices',
        });
      }
    }
    // Fixed pages always last
    out.push(...FIXED_PAGES);
    return out;
  }, [
    storyboardQuery.data,
    projectsQuery.data,
    brandsQuery.data,
    voicesQuery.data,
    projectId,
  ]);

  // Score + sort by query
  const filtered = useMemo(() => {
    const q = query.trim();
    const scored = items
      .map((item) => ({ item, score: fuzzyScore(item.label + ' ' + (item.hint ?? ''), q) }))
      .filter((row) => row.score > 0);
    if (q.length === 0) {
      // Show items in their natural order grouped by category
      return scored;
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 25);
  }, [items, query]);

  // Keep activeIndex in bounds when filtering changes
  useEffect(() => {
    if (activeIndex >= filtered.length) setActiveIndex(0);
  }, [filtered.length, activeIndex]);

  const choose = (item: PaletteItem) => {
    setOpen(false);
    navigate(item.to);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, Math.max(filtered.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const row = filtered[activeIndex];
      if (row) choose(row.item);
    }
  };

  // Auto-scroll active item into view
  useEffect(() => {
    if (!open) return;
    const list = listRef.current;
    if (!list) return;
    const el = list.querySelector<HTMLDivElement>(`[data-palette-idx="${activeIndex}"]`);
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      onClick={() => setOpen(false)}
      className="cmdk-overlay"
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: '15vh',
        zIndex: 1200,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="cmdk-panel"
        style={{
          width: 'min(560px, 92vw)',
          maxHeight: '60vh',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={onKeyDown}
          placeholder="Jump to project, scene, brand, voice, or page…"
          style={{
            border: 'none',
            background: 'transparent',
            color: 'var(--fg)',
            padding: '14px 16px',
            fontSize: 15,
            outline: 'none',
            borderBottom: '1px solid var(--border)',
          }}
        />

        <div ref={listRef} style={{ overflowY: 'auto', flex: 1 }}>
          {filtered.length === 0 ? (
            <div style={{ padding: 16, fontSize: 13, color: 'var(--fg-muted)', textAlign: 'center' }}>
              No matches
            </div>
          ) : (
            <PaletteResults
              filtered={filtered.map((r) => r.item)}
              activeIndex={activeIndex}
              onChoose={choose}
              onHover={setActiveIndex}
              groupHeaders={query.trim().length === 0}
            />
          )}
        </div>

        <div style={{
          padding: '8px 16px',
          borderTop: '1px solid var(--border)',
          fontSize: 11,
          color: 'var(--fg-muted)',
          display: 'flex',
          justifyContent: 'space-between',
        }}>
          <span>↑↓ navigate · ↵ open · esc close</span>
          <span>⌘K to toggle</span>
        </div>
      </div>
    </div>
  );
}

function PaletteResults({
  filtered,
  activeIndex,
  onChoose,
  onHover,
  groupHeaders,
}: {
  filtered: PaletteItem[];
  activeIndex: number;
  onChoose: (item: PaletteItem) => void;
  onHover: (idx: number) => void;
  groupHeaders: boolean;
}) {
  // When no query is typed, render group headings so the user gets a sense
  // of what's available; otherwise render flat by score.
  if (!groupHeaders) {
    return (
      <div>
        {filtered.map((item, idx) => (
          <Row
            key={item.id}
            item={item}
            idx={idx}
            active={idx === activeIndex}
            onChoose={onChoose}
            onHover={onHover}
          />
        ))}
      </div>
    );
  }
  // Grouped rendering
  const groups: PaletteItem['group'][] = ['Scenes', 'Projects', 'Brands', 'Voices', 'Pages'];
  let runningIdx = 0;
  return (
    <div>
      {groups.map((g) => {
        const items = filtered.filter((i) => i.group === g);
        if (items.length === 0) return null;
        const start = runningIdx;
        runningIdx += items.length;
        return (
          <div key={g}>
            <div style={{
              padding: '6px 16px 4px',
              fontSize: 10,
              color: 'var(--fg-muted)',
              textTransform: 'uppercase',
              letterSpacing: 1,
              fontWeight: 600,
            }}>
              {g}
            </div>
            {items.map((item, i) => (
              <Row
                key={item.id}
                item={item}
                idx={start + i}
                active={start + i === activeIndex}
                onChoose={onChoose}
                onHover={onHover}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}

function Row({
  item,
  idx,
  active,
  onChoose,
  onHover,
}: {
  item: PaletteItem;
  idx: number;
  active: boolean;
  onChoose: (item: PaletteItem) => void;
  onHover: (idx: number) => void;
}) {
  return (
    <div
      role="option"
      aria-selected={active}
      data-palette-idx={idx}
      onMouseEnter={() => onHover(idx)}
      onClick={() => onChoose(item)}
      style={{
        padding: '8px 16px',
        fontSize: 13,
        cursor: 'pointer',
        background: active ? 'var(--accent-bg)' : 'transparent',
        color: active ? 'var(--accent)' : 'var(--fg)',
        borderLeft: active ? '2px solid var(--accent)' : '2px solid transparent',
        display: 'flex',
        alignItems: 'baseline',
        gap: 10,
      }}
    >
      <span style={{ fontWeight: 500, flexShrink: 0 }}>{item.label}</span>
      {item.hint && (
        <span
          style={{
            fontSize: 11,
            color: active ? 'var(--accent)' : 'var(--fg-muted)',
            opacity: active ? 0.85 : 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {item.hint}
        </span>
      )}
    </div>
  );
}
