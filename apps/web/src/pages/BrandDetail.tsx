import { useState, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { brandsApi, ApiError } from '../lib/api';
import type { DesignMdFrontMatter, BrandWithDoc } from '@vpa/shared';

type Tab = 'overview' | 'tokens' | 'markdown' | 'assets' | 'usage';

/* ── Sub-components ────────────────────────────────────────── */

function TokensTable({ frontMatter }: { frontMatter: DesignMdFrontMatter }) {
  const rows: [string, string][] = [];

  function flatten(obj: unknown, prefix: string) {
    if (obj === null || obj === undefined) {
      rows.push([prefix, 'null']);
      return;
    }
    if (typeof obj === 'string' || typeof obj === 'number' || typeof obj === 'boolean') {
      rows.push([prefix, String(obj)]);
      return;
    }
    if (Array.isArray(obj)) {
      if (obj.length === 0) {
        rows.push([prefix, '[]']);
      } else {
        obj.forEach((v, i) => flatten(v, `${prefix}[${i}]`));
      }
      return;
    }
    if (typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        flatten(v, prefix ? `${prefix}.${k}` : k);
      }
    }
  }

  flatten(frontMatter, '');

  return (
    <table className="tokens-table">
      <thead>
        <tr>
          <th>Token</th>
          <th>Value</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([key, val]) => (
          <tr key={key}>
            <td>
              <code>{key}</code>
            </td>
            <td>
              {val.startsWith('#') ? (
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span
                    style={{
                      display: 'inline-block',
                      width: 14,
                      height: 14,
                      borderRadius: 3,
                      background: val,
                      border: '1px solid var(--border)',
                    }}
                  />
                  {val}
                </span>
              ) : (
                val
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function LogoUploadCard({
  label,
  currentPath,
  slug,
  field,
  onUploaded,
}: {
  label: string;
  currentPath: string | null | undefined;
  slug: string;
  field: 'primary' | 'mono';
  onUploaded: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError('');
    try {
      await brandsApi.uploadAsset(slug, field, file);
      onUploaded();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const imgUrl = currentPath ? brandsApi.assetUrl(slug, currentPath) : null;

  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 10,
        padding: 16,
        background: 'var(--surface)',
        minWidth: 220,
        textAlign: 'center',
      }}
    >
      <p style={{ fontWeight: 600, fontSize: 13, margin: '0 0 12px' }}>{label}</p>
      {imgUrl ? (
        <img
          src={imgUrl}
          alt={`${label} logo`}
          style={{
            maxWidth: 180,
            maxHeight: 120,
            objectFit: 'contain',
            borderRadius: 6,
            background: 'var(--bg-elev)',
            padding: 8,
          }}
        />
      ) : (
        <div
          style={{
            width: 180,
            height: 100,
            margin: '0 auto',
            borderRadius: 6,
            border: '2px dashed var(--border)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--fg-muted)',
            fontSize: 13,
          }}
        >
          No logo
        </div>
      )}
      <div style={{ marginTop: 12 }}>
        <input
          ref={inputRef}
          type="file"
          accept=".png,.jpg,.jpeg,.svg,.webp"
          style={{ display: 'none' }}
          onChange={handleFile}
        />
        <button
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
          style={{
            padding: '6px 14px',
            borderRadius: 6,
            border: '1px solid var(--accent)',
            background: 'transparent',
            color: 'var(--accent)',
            cursor: uploading ? 'wait' : 'pointer',
            fontSize: 13,
          }}
        >
          {uploading ? 'Uploading...' : imgUrl ? 'Replace' : 'Upload'}
        </button>
      </div>
      {error && <p style={{ color: 'var(--danger, #c44)', fontSize: 12, marginTop: 6 }}>{error}</p>}
    </div>
  );
}

function AssetsPane({ data, slug, onRefresh }: { data: BrandWithDoc; slug: string; onRefresh: () => void }) {
  const vpa = data.doc.frontMatter.vpa;
  return (
    <div>
      <h3 style={{ marginTop: 0 }}>Logos</h3>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <LogoUploadCard
          label="Primary Logo"
          currentPath={vpa?.logo.primary}
          slug={slug}
          field="primary"
          onUploaded={onRefresh}
        />
        <LogoUploadCard
          label="Mono Logo"
          currentPath={vpa?.logo.mono}
          slug={slug}
          field="mono"
          onUploaded={onRefresh}
        />
      </div>
      <p style={{ color: 'var(--fg-muted)', fontSize: 12, marginTop: 12 }}>
        Supported formats: PNG, JPG, SVG, WebP
      </p>
    </div>
  );
}

function UsagePane({ slug }: { slug: string }) {
  return (
    <div>
      <p style={{ color: 'var(--fg-muted)', fontSize: 13 }}>
        Projects using brand <strong>{slug}</strong> will be listed here once project-brand
        linking is implemented.
      </p>
    </div>
  );
}

/* ── Main page ─────────────────────────────────────────────── */

export default function BrandDetail() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [tab, setTab] = useState<Tab>('overview');
  const [deleteConfirm, setDeleteConfirm] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ['brand', slug],
    queryFn: () => brandsApi.detail(slug!),
    enabled: !!slug,
  });

  const { data: registry } = useQuery({
    queryKey: ['brands'],
    queryFn: () => brandsApi.list(),
  });

  const isDefault = registry?.default_brand_id === slug;

  const setDefaultMut = useMutation({
    mutationFn: (val: boolean) => brandsApi.setDefault(slug!, val),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['brands'] });
      queryClient.invalidateQueries({ queryKey: ['brand', slug] });
    },
  });

  const forkMut = useMutation({
    mutationFn: (name: string) => brandsApi.fork(slug!, name),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['brands'] });
      navigate(`/brands/${result.registry.id}`);
    },
  });

  const regenerateMut = useMutation({
    mutationFn: () => brandsApi.regenerate(slug!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['brand', slug] });
    },
  });

  const deleteMut = useMutation({
    mutationFn: (force: boolean) => brandsApi.deleteBrand(slug!, force),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['brands'] });
      navigate('/');
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409) {
        // Brand is used by projects, offer force delete
        if (confirm('This brand is used by projects. Force delete?')) {
          deleteMut.mutate(true);
        }
      }
    },
  });

  const handleFork = () => {
    const forkName = prompt('Enter a name for the forked brand:');
    if (forkName?.trim()) {
      forkMut.mutate(forkName.trim());
    }
  };

  const handleDelete = () => {
    if (!deleteConfirm) {
      setDeleteConfirm(true);
      return;
    }
    deleteMut.mutate(false);
    setDeleteConfirm(false);
  };

  if (isLoading) {
    return (
      <main className="brand-detail">
        <p style={{ color: 'var(--fg-muted)' }}>Loading...</p>
      </main>
    );
  }

  if (error || !data) {
    return (
      <main className="brand-detail">
        <p style={{ color: 'var(--danger)' }}>
          {error instanceof Error ? error.message : 'Brand not found'}
        </p>
        <button onClick={() => navigate('/')}>Back to dashboard</button>
      </main>
    );
  }

  const { registry: entry, doc } = data;
  const fm = doc.frontMatter;

  const tabs: { key: Tab; label: string }[] = [
    { key: 'overview', label: 'Overview' },
    { key: 'tokens', label: 'Tokens' },
    { key: 'markdown', label: 'Markdown' },
    { key: 'assets', label: 'Assets' },
    { key: 'usage', label: 'Usage' },
  ];

  return (
    <main className="brand-detail">
      {/* Header */}
      <div className="brand-detail__header">
        <h1 style={{ margin: 0 }}>{entry.name}</h1>
        <span className="brand-detail__meta">v{entry.version}</span>
        {entry.forked_from && (
          <span className="brand-detail__meta">
            forked from <a href={`/brands/${entry.forked_from}`}>{entry.forked_from}</a>
          </span>
        )}
        <label className="brand-detail__default">
          <input
            type="checkbox"
            checked={isDefault}
            onChange={(e) => setDefaultMut.mutate(e.target.checked)}
          />
          Default brand
        </label>
      </div>

      {/* Actions */}
      <div className="brand-detail__actions">
        <a href={brandsApi.downloadUrl(slug!)} download>
          <button type="button">Download design.md</button>
        </a>
        <button
          type="button"
          disabled={regenerateMut.isPending}
          onClick={() => regenerateMut.mutate()}
        >
          {regenerateMut.isPending ? 'Regenerating...' : 'Regenerate'}
        </button>
        <button type="button" onClick={handleFork} disabled={forkMut.isPending}>
          {forkMut.isPending ? 'Forking...' : 'Fork'}
        </button>
        <button
          type="button"
          className="button--danger"
          onClick={handleDelete}
          disabled={deleteMut.isPending}
        >
          {deleteMut.isPending
            ? 'Deleting...'
            : deleteConfirm
              ? 'Confirm Delete'
              : 'Delete'}
        </button>
        {deleteConfirm && (
          <button type="button" onClick={() => setDeleteConfirm(false)}>
            Cancel
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="brand-detail__tabs">
        {tabs.map((t) => (
          <button
            key={t.key}
            className={tab === t.key ? 'active' : ''}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === 'overview' && (
        <div>
          {fm.description && <p>{fm.description}</p>}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
            {Object.entries(fm.colors).map(([key, hex]) => (
              <div
                key={key}
                style={{
                  width: 60,
                  height: 40,
                  borderRadius: 5,
                  background: hex,
                  border: '1px solid var(--border)',
                  display: 'flex',
                  alignItems: 'flex-end',
                  padding: 3,
                  fontSize: 9,
                  fontFamily: 'monospace',
                  color: contrastColor(hex),
                }}
              >
                {key}
              </div>
            ))}
          </div>
          <p style={{ fontSize: 13, color: 'var(--fg-muted)' }}>
            Typography: {Object.values(fm.typography).map(l => l.fontFamily).filter((v, i, a) => a.indexOf(v) === i).join(' / ')}
          </p>
          {fm.vpa?.taglines && fm.vpa.taglines.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <strong style={{ fontSize: 13 }}>Taglines</strong>
              <ul style={{ margin: '4px 0', paddingLeft: 16, fontSize: 13 }}>
                {fm.vpa.taglines.map((t, i) => (
                  <li key={i}>{t}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {tab === 'tokens' && <TokensTable frontMatter={fm} />}

      {tab === 'markdown' && (
        <pre
          style={{
            background: 'var(--bg-elev)',
            padding: 14,
            borderRadius: 6,
            fontSize: 12,
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            color: 'var(--fg-muted)',
          }}
        >
          {doc.body}
        </pre>
      )}

      {tab === 'assets' && <AssetsPane data={data} slug={slug!} onRefresh={() => queryClient.invalidateQueries({ queryKey: ['brand', slug] })} />}

      {tab === 'usage' && <UsagePane slug={slug!} />}
    </main>
  );
}

function contrastColor(hex: string): string {
  const c = hex.replace('#', '');
  const r = parseInt(c.substring(0, 2), 16);
  const g = parseInt(c.substring(2, 4), 16);
  const b = parseInt(c.substring(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5 ? '#000000' : '#ffffff';
}
