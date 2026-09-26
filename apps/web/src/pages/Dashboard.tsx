import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Lightbulb, Presentation, Video } from 'lucide-react';
import { ProjectList } from '../components/ProjectList.js';
import { NewProjectDialog } from '../components/NewProjectDialog.js';
import { OpenFolderDialog } from '../components/OpenFolderDialog.js';

type Modal = 'none' | 'new' | 'open' | 'new-ideation' | 'new-presentation';

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

  const handlePresentationCreated = (id: string, result?: { presentationId: string }) => {
    const suffix = result ? `?presentation=${encodeURIComponent(result.presentationId)}` : '';
    navigate(`/project/${id}/storyboard${suffix}`);
  };

  return (
    <main className="page dashboard">
      <header className="dashboard__header">
        <h1>Video Production Assistant</h1>
        <p style={{ color: 'var(--fg-muted)', fontSize: 14, margin: 0 }}>
          Plan, narrate, and finish polished videos in one workspace.
        </p>
      </header>

      <div className="hero-grid">
        <button
          className="hero-card hero-card--ideate"
          aria-label="Start with an idea"
          onClick={() => setModal('new-ideation')}
        >
          <span className="hero-card__icon">
            <Lightbulb size={28} strokeWidth={1.5} />
          </span>
          <div className="hero-card__title">Start with an idea</div>
          <div className="hero-card__desc">
            Describe your goal or add reference docs. VPA will propose a storyboard.
          </div>
        </button>
        <button
          className="hero-card hero-card--presentation"
          aria-label="Import slides"
          onClick={() => setModal('new-presentation')}
        >
          <span className="hero-card__icon">
            <Presentation size={28} strokeWidth={1.5} />
          </span>
          <div className="hero-card__title">Import slides</div>
          <div className="hero-card__desc">
            Upload a PDF and create one narratable scene per slide.
          </div>
        </button>
        <button
          className="hero-card hero-card--record"
          aria-label="Import recordings"
          onClick={() => setModal('new')}
        >
          <span className="hero-card__icon">
            <Video size={28} strokeWidth={1.5} />
          </span>
          <div className="hero-card__title">Import recordings</div>
          <div className="hero-card__desc">
            Add existing video clips, then write scripts and narration.
          </div>
        </button>
      </div>

      <section aria-label="Recent projects">
        <div className="section-header">
          <h2 className="section-title">Recent projects</h2>
        </div>
        <ProjectList onOpen={(p) => handleOpen(p.id)} onOpenFolder={() => setModal('open')} />
      </section>

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
      <NewProjectDialog
        open={modal === 'new-presentation'}
        mode="presentation"
        onClose={() => setModal('none')}
        onCreated={handlePresentationCreated}
      />
      <OpenFolderDialog
        open={modal === 'open'}
        onClose={() => setModal('none')}
        onImported={handleOpen}
      />
    </main>
  );
}
