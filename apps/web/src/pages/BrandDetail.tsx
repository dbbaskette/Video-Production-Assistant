import { useState, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { brandsApi, ApiError } from '../lib/api';
import { useUi } from '../components/ui/UiProvider.js';
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
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span
                    style={{
                      display: 'inline-block',
                      width: 16,
                      height: 16,
                      borderRadius: 4,
                      background: val,
                      border: '1px solid rgba(255,255,255,0.06)',
                    }}
                  />
                  <code style={{ color: 'var(--fg-muted)' }}>{val}</code>
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
    <div className="card" style={{ minWidth: 220, textAlign: 'center', flex: 1 }}>
      <p style={{ fontWeight: 600, fontSize: 13, margin: '0 0 14px', color: 'var(--fg-muted)' }}>{label}</p>
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
            borderRadius: 8,
            border: '2px dashed var(--border)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--fg-dim)',
            fontSize: 13,
          }}
        >
          No logo
        </div>
      )}
      <div style={{ marginTop: 14 }}>
        <input
          ref={inputRef}
          type="file"
          accept=".png,.jpg,.jpeg,.svg,.webp"
          style={{ display: 'none' }}
          onChange={handleFile}
        />
        <button
          className="btn--outline-accent"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
          style={{ fontSize: 12 }}
        >
          {uploading ? 'Uploading...' : imgUrl ? 'Replace' : 'Upload'}
        </button>
      </div>
      {error && <p style={{ color: 'var(--danger)', fontSize: 12, marginTop: 6 }}>{error}</p>}
    </div>
  );
}

function AssetsPane({ data, slug, onRefresh }: { data: BrandWithDoc; slug: string; onRefresh: () => void }) {
  const vpa = data.doc.frontMatter.vpa;
  const audio = vpa?.audio as
    | {
        bumper_intro?: string | null;
        bumper_outro?: string | null;
        default_music_track?: string | null;
      }
    | undefined;
  return (
    <div style={{ display: 'grid', gap: 32 }}>
      {/* ── Logos ────────────────────────────────────────────── */}
      <div>
        <h3 style={{ margin: '0 0 14px' }}>Logos</h3>
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
        <p className="hint" style={{ marginTop: 14 }}>
          Supported formats: PNG, JPG, SVG, WebP
        </p>
      </div>

      {/* ── Bumpers ──────────────────────────────────────────────
          Start/end bumper videos — applied to every project render
          that uses this brand. The render pipeline normalises them
          to the project's scene dimensions before concat, so file
          shape doesn't have to match exactly. */}
      <div>
        <h3 style={{ margin: '0 0 4px' }}>Bumpers</h3>
        <p style={{ fontSize: 13, color: 'var(--fg-muted)', margin: '0 0 14px' }}>
          Short video clips that play at the start and end of every render. Scaled
          to fit the project's scene size.
        </p>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <MediaUploadCard
            kind="video"
            label="Start bumper"
            currentPath={audio?.bumper_intro ?? null}
            slug={slug}
            field="bumper-intro"
            accept="video/mp4,video/quicktime,.mp4,.mov"
            onChange={onRefresh}
          />
          <MediaUploadCard
            kind="video"
            label="End bumper"
            currentPath={audio?.bumper_outro ?? null}
            slug={slug}
            field="bumper-outro"
            accept="video/mp4,video/quicktime,.mp4,.mov"
            onChange={onRefresh}
          />
        </div>
      </div>

      {/* ── Default music ────────────────────────────────────────
          Optional background track applied when a project doesn't
          pick its own. Project-level music selections still override. */}
      <div>
        <h3 style={{ margin: '0 0 4px' }}>Default music</h3>
        <p style={{ fontSize: 13, color: 'var(--fg-muted)', margin: '0 0 14px' }}>
          Looped under narration on every render using this brand. Projects can
          override per-render.
        </p>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <MediaUploadCard
            kind="audio"
            label="Music track"
            currentPath={audio?.default_music_track ?? null}
            slug={slug}
            field="default-music"
            accept="audio/mpeg,audio/wav,audio/mp4,.mp3,.wav,.m4a"
            onChange={onRefresh}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * Generic upload card for video or audio brand assets. Renders the existing
 * media (preview <video>/<audio>) if any, plus Upload / Replace and Remove
 * buttons that drive the brandsApi.uploadAsset / deleteAsset endpoints.
 */
function MediaUploadCard({
  kind,
  label,
  currentPath,
  slug,
  field,
  accept,
  onChange,
}: {
  kind: 'video' | 'audio';
  label: string;
  currentPath: string | null;
  slug: string;
  field: 'bumper-intro' | 'bumper-outro' | 'default-music' | 'sonic-logo';
  accept: string;
  onChange: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<'upload' | 'delete' | null>(null);
  const [error, setError] = useState('');

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy('upload');
    setError('');
    try {
      await brandsApi.uploadAsset(slug, field, file);
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setBusy(null);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const handleRemove = async () => {
    setBusy('delete');
    setError('');
    try {
      await brandsApi.deleteAsset(slug, field);
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Remove failed');
    } finally {
      setBusy(null);
    }
  };

  const mediaUrl = currentPath ? brandsApi.assetUrl(slug, currentPath) : null;
  const filename = currentPath ? currentPath.split('/').pop() : null;

  return (
    <div className="card" style={{ minWidth: 280, flex: 1, textAlign: 'center' }}>
      <p style={{ fontWeight: 600, fontSize: 13, margin: '0 0 14px', color: 'var(--fg-muted)' }}>
        {label}
      </p>
      {mediaUrl ? (
        kind === 'video' ? (
          <video
            key={mediaUrl}
            src={mediaUrl}
            controls
            playsInline
            preload="metadata"
            style={{
              width: '100%',
              maxWidth: 280,
              borderRadius: 6,
              background: '#000',
              aspectRatio: '16 / 9',
            }}
          />
        ) : (
          <audio
            key={mediaUrl}
            src={mediaUrl}
            controls
            preload="metadata"
            style={{ width: '100%', maxWidth: 280 }}
          />
        )
      ) : (
        <div
          style={{
            width: '100%',
            maxWidth: 280,
            margin: '0 auto',
            aspectRatio: kind === 'video' ? '16 / 9' : 'auto',
            minHeight: kind === 'audio' ? 60 : undefined,
            borderRadius: 8,
            border: '2px dashed var(--border)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--fg-dim)',
            fontSize: 13,
          }}
        >
          {kind === 'video' ? 'No bumper' : 'No track'}
        </div>
      )}
      {filename && (
        <p
          style={{
            fontSize: 11,
            color: 'var(--fg-muted)',
            margin: '8px 0 0',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {filename}
        </p>
      )}
      <div style={{ marginTop: 12, display: 'inline-flex', gap: 8 }}>
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          style={{ display: 'none' }}
          onChange={handleFile}
        />
        <button
          className="btn--outline-accent"
          onClick={() => inputRef.current?.click()}
          disabled={busy !== null}
          style={{ fontSize: 12 }}
        >
          {busy === 'upload' ? 'Uploading…' : mediaUrl ? 'Replace' : 'Upload'}
        </button>
        {mediaUrl && (
          <button
            onClick={handleRemove}
            disabled={busy !== null}
            style={{
              fontSize: 12,
              padding: '6px 12px',
              background: 'transparent',
              color: 'var(--danger)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              cursor: busy ? 'wait' : 'pointer',
            }}
          >
            {busy === 'delete' ? 'Removing…' : 'Remove'}
          </button>
        )}
      </div>
      {error && <p style={{ color: 'var(--danger)', fontSize: 12, marginTop: 6 }}>{error}</p>}
    </div>
  );
}

function UsagePane({ slug }: { slug: string }) {
  // Queries the same `GET /api/brands/:slug/projects` endpoint that the brand
  // deletion check uses — projects are matched by `brand.id === slug` on each
  // project.yaml. Empty state = "no project currently uses this brand".
  const { data, isLoading, error } = useQuery({
    queryKey: ['brand-projects', slug],
    queryFn: () => brandsApi.listProjects(slug),
    enabled: !!slug,
  });

  if (isLoading) {
    return <div className="empty-state">Loading projects…</div>;
  }
  if (error) {
    return (
      <div className="empty-state" style={{ color: 'var(--danger)' }}>
        Failed to load: {error instanceof Error ? error.message : 'unknown error'}
      </div>
    );
  }

  const projects = data?.projects ?? [];
  if (projects.length === 0) {
    return (
      <div className="empty-state">
        No projects use brand <strong>{slug}</strong> yet. Pick this brand on a project's
        Overview to link it.
      </div>
    );
  }

  return (
    <div>
      <p style={{ fontSize: 13, color: 'var(--fg-muted)', margin: '0 0 14px' }}>
        {projects.length} project{projects.length === 1 ? '' : 's'} use{' '}
        <strong>{slug}</strong>:
      </p>
      <div style={{ display: 'grid', gap: 8 }}>
        {projects.map((p) => (
          <Link
            key={p.id}
            to={`/project/${p.id}`}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '12px 14px',
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
              textDecoration: 'none',
              color: 'inherit',
              transition: 'border-color 120ms',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'var(--accent)')}
            onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'var(--border)')}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 500 }}>{p.name}</div>
              <div
                style={{
                  fontSize: 12,
                  color: 'var(--fg-muted)',
                  marginTop: 2,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {p.path}
              </div>
            </div>
            <span
              style={{
                fontSize: 12,
                color: 'var(--fg-muted)',
                padding: '4px 10px',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-sm)',
              }}
            >
              Open
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}

/* ── Main page ─────────────────────────────────────────────── */

export default function BrandDetail() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const ui = useUi();

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
    onError: async (err) => {
      if (err instanceof ApiError && err.status === 409) {
        const ok = await ui.confirm({
          title: 'Brand is in use',
          body: 'One or more projects currently reference this brand. Force delete anyway? Their applied-brand pointer will be cleared.',
          confirmLabel: 'Force delete',
          destructive: true,
        });
        if (ok) deleteMut.mutate(true);
      }
    },
  });

  const handleFork = async () => {
    const forkName = await ui.prompt({
      title: 'Fork brand',
      body: `Create a copy of "${slug}" that you can edit independently. Choose a name for the new brand.`,
      placeholder: 'e.g. tanzu-2025',
      confirmLabel: 'Fork',
      validate: (v) => (v.length === 0 ? 'Name is required' : v.length > 80 ? 'Too long' : null),
    });
    if (forkName) forkMut.mutate(forkName);
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
      {/* Breadcrumb */}
      <Link to="/" className="brand-detail__breadcrumb">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="15 18 9 12 15 6" />
        </svg>
        All Brands
      </Link>

      {/* Header */}
      <div className="brand-detail__header">
        <h1 style={{ margin: 0 }}>{entry.name}</h1>
        <span className="brand-detail__meta">v{entry.version}</span>
        {entry.forked_from && (
          <span className="brand-detail__meta">
            forked from <Link to={`/brands/${entry.forked_from}`}>{entry.forked_from}</Link>
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
        <a href={brandsApi.downloadUrl(slug!)} download style={{ textDecoration: 'none' }}>
          <button type="button">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 6, verticalAlign: -2 }}>
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            Download
          </button>
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

        <div style={{ flex: 1 }} />

        <button
          type="button"
          className="btn--danger"
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
          <button type="button" className="btn--ghost" onClick={() => setDeleteConfirm(false)}>
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
          {fm.description && <p className="brand-detail__overview-desc">{fm.description}</p>}

          <div className="brand-detail__color-grid">
            {Object.entries(fm.colors).map(([key, hex]) => (
              <div
                key={key}
                className="brand-detail__color-swatch"
                style={{
                  background: hex,
                  color: contrastColor(hex),
                }}
              >
                {key}
              </div>
            ))}
          </div>

          <p className="hint">
            Typography: {Object.values(fm.typography).map(l => l.fontFamily).filter((v, i, a) => a.indexOf(v) === i).join(' / ')}
          </p>

          {fm.vpa?.taglines && fm.vpa.taglines.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <h3 style={{ fontSize: 13, color: 'var(--fg-muted)' }}>Taglines</h3>
              <ul style={{ margin: '6px 0', paddingLeft: 18, fontSize: 14, lineHeight: 1.6 }}>
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
            padding: 18,
            borderRadius: 'var(--radius-md)',
            fontSize: 12,
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            color: 'var(--fg-muted)',
            lineHeight: 1.6,
            border: '1px solid var(--border)',
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
