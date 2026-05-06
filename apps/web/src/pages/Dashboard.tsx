import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { Lightbulb, Video } from 'lucide-react';
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

  if (isLoading) return <section><p className="hint">Loading brands...</p></section>;
  if (error) return <section><p style={{ color: 'var(--danger)' }}>Failed to load brands.</p></section>;

  const list = data!.brands;
  return (
    <section aria-label="Brands" style={{ marginTop: 36 }}>
      <div className="section-header">
        <span className="section-label">Brands</span>
        <Link to="/brands/new">
          <button className="btn--outline-accent" style={{ fontSize: 12, padding: '5px 12px' }}>
            + New Brand
          </button>
        </Link>
      </div>
      {list.length === 0 ? (
        <div className="empty-state">
          No brands yet. Create your first brand to apply consistent visual identity across video projects.
        </div>
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

  // "I have recordings" → land directly on the upload screen so the user
  // doesn't have to hunt for it from Project Overview. The RecordingsPage
  // detects there's no storyboard yet and offers the "generate storyboard
  // from recordings" flow that matches the entry-point's promise.
  const handleRecordingsCreated = (id: string) => {
    navigate(`/project/${id}/recordings`);
  };

  return (
    <main className="page">
      <header style={{ marginBottom: 32 }}>
        <h1>Video Production Assistant</h1>
        <p style={{ color: 'var(--fg-muted)', fontSize: 14, margin: 0 }}>
          Speed up the post-recording phase of demo video creation.
        </p>
      </header>

      <div className="hero-grid">
        <button
          className="hero-card hero-card--ideate"
          aria-label="Ideate a new demo"
          onClick={() => setModal('new-ideation')}
        >
          <span className="hero-card__icon"><Lightbulb size={28} strokeWidth={1.5} /></span>
          <div className="hero-card__title">Ideate a new demo</div>
          <div className="hero-card__desc">
            Drop docs and describe what to demo. AI proposes a storyboard.
          </div>
        </button>
        <button
          className="hero-card hero-card--record"
          aria-label="I have recordings"
          onClick={() => setModal('new')}
        >
          <span className="hero-card__icon"><Video size={28} strokeWidth={1.5} /></span>
          <div className="hero-card__title">I have recordings</div>
          <div className="hero-card__desc">
            Upload mp4(s); we'll script and narrate.
          </div>
        </button>
      </div>

      <section aria-label="Recent projects">
        <div className="section-header">
          <span className="section-label">Recent</span>
          <button onClick={() => setModal('open')} style={{ fontSize: 12, padding: '5px 12px' }}>
            Open folder...
          </button>
        </div>
        <ProjectList onOpen={(p) => handleOpen(p.id)} />
      </section>

      <BrandsSection />

      <NewProjectDialog
        open={modal === 'new'}
        mode="recordings"
        onClose={() => setModal('none')}
        onCreated={handleRecordingsCreated}
      />
      <NewProjectDialog
        open={modal === 'new-ideation'}
        mode="ideate"
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
