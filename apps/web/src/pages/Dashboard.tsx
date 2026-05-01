import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { ProjectList } from '../components/ProjectList.js';
import { NewProjectDialog } from '../components/NewProjectDialog.js';
import { OpenFolderDialog } from '../components/OpenFolderDialog.js';
import { brandsApi } from '../lib/api.js';
import { BrandCard } from '../components/BrandCard.js';

function BrandsSection() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['brands'],
    queryFn: () => brandsApi.list(),
  });

  if (isLoading) return <section><h2>Brands</h2><p>Loading...</p></section>;
  if (error) return <section><h2>Brands</h2><p>Failed to load brands.</p></section>;

  const list = data!.brands;
  return (
    <section aria-label="Brands" style={{ marginTop: 32 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 14, textTransform: 'uppercase', color: 'var(--fg-muted)', letterSpacing: 1 }}>
          Brands
        </h2>
        <Link to="/brands/new" className="primary" style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid var(--accent)', background: 'var(--accent-bg)', color: 'var(--fg)', textDecoration: 'none', fontSize: 13 }}>
          + New Brand
        </Link>
      </div>
      {list.length === 0 ? (
        <p style={{ color: 'var(--fg-muted)' }}>No brands yet. Create your first brand to apply consistent visual identity across video projects.</p>
      ) : (
        <div className="brand-grid">
          {list.map((entry) => (
            <BrandCard key={entry.id} entry={entry} isDefault={entry.id === data!.default_brand_id} />
          ))}
        </div>
      )}
    </section>
  );
}

type Modal = 'none' | 'new' | 'open' | 'new-ideation';

export function Dashboard() {
  const [modal, setModal] = useState<Modal>('none');
  const navigate = useNavigate();

  const handleOpen = (id: string) => {
    navigate(`/project/${id}`);
  };

  const handleIdeationCreated = (id: string) => {
    navigate(`/project/${id}/ideation`);
  };

  return (
    <main
      style={{
        maxWidth: 960, margin: '0 auto', padding: '40px 24px',
      }}
    >
      <header style={{ marginBottom: 32, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 style={{ margin: 0 }}>Video Production Assistant</h1>
          <p style={{ color: 'var(--fg-muted)', marginTop: 4 }}>
            Speed up the post-recording phase of demo video creation.
          </p>
        </div>
        <Link
          to="/settings"
          title="Settings"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 36,
            height: 36,
            borderRadius: 8,
            border: '1px solid var(--border)',
            background: 'var(--surface)',
            color: 'var(--fg-muted)',
            textDecoration: 'none',
            fontSize: 18,
            marginTop: 4,
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </Link>
      </header>

      <section
        aria-label="Front doors"
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 16,
          marginBottom: 32,
        }}
      >
        <button
          aria-label="Ideate a new demo"
          onClick={() => setModal('new-ideation')}
          style={{
            background: 'var(--accent-bg)',
            border: '1px solid var(--accent)',
            borderRadius: 12,
            padding: '24px',
            textAlign: 'left',
            cursor: 'pointer',
          }}
        >
          <div style={{ fontSize: 28, marginBottom: 8 }}>💡</div>
          <div style={{ fontWeight: 700, fontSize: 18 }}>Ideate a new demo</div>
          <div style={{ color: 'var(--fg-muted)', marginTop: 4, fontSize: 13 }}>
            Drop docs and describe what to demo. AI proposes a storyboard.
          </div>
        </button>
        <button
          aria-label="I have recordings"
          onClick={() => setModal('new')}
          style={{
            background: 'rgba(94,138,58,0.15)',
            border: '1px solid var(--success)',
            borderRadius: 12,
            padding: '24px',
            textAlign: 'left',
            cursor: 'pointer',
          }}
        >
          <div style={{ fontSize: 28, marginBottom: 8 }}>📹</div>
          <div style={{ fontWeight: 700, fontSize: 18 }}>I have recordings</div>
          <div style={{ color: 'var(--fg-muted)', marginTop: 4, fontSize: 13 }}>
            Upload mp4(s); we'll script and narrate.
          </div>
        </button>
      </section>

      <section aria-label="Recent projects">
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            marginBottom: 12,
          }}
        >
          <h2 style={{ margin: 0, fontSize: 14, textTransform: 'uppercase', color: 'var(--fg-muted)', letterSpacing: 1 }}>
            Recent
          </h2>
          <button onClick={() => setModal('open')}>Open folder…</button>
        </div>
        <ProjectList onOpen={(p) => handleOpen(p.id)} />
      </section>

      <BrandsSection />

      <NewProjectDialog
        open={modal === 'new'}
        onClose={() => setModal('none')}
        onCreated={handleOpen}
      />
      <NewProjectDialog
        open={modal === 'new-ideation'}
        onClose={() => setModal('none')}
        onCreated={handleIdeationCreated}
      />
      <OpenFolderDialog
        open={modal === 'open'}
        onClose={() => setModal('none')}
        onImported={handleOpen}
      />
    </main>
  );
}
