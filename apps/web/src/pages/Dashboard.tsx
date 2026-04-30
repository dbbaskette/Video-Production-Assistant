import { useState } from 'react';
import { ProjectList } from '../components/ProjectList.js';
import { NewProjectDialog } from '../components/NewProjectDialog.js';
import { OpenFolderDialog } from '../components/OpenFolderDialog.js';

type Modal = 'none' | 'new' | 'open';

export function Dashboard() {
  const [modal, setModal] = useState<Modal>('none');

  // For Plan 01, opening a project just logs to the console — the project workspace
  // page is built in Plan 02. The dialogs invalidate the list on success.
  const handleOpen = (id: string) => {
    console.info('open project', id);
  };

  return (
    <main
      style={{
        maxWidth: 960, margin: '0 auto', padding: '40px 24px',
      }}
    >
      <header style={{ marginBottom: 32 }}>
        <h1 style={{ margin: 0 }}>Video Production Assistant</h1>
        <p style={{ color: 'var(--fg-muted)', marginTop: 4 }}>
          Speed up the post-recording phase of demo video creation.
        </p>
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
          onClick={() => setModal('new')}
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

      <NewProjectDialog
        open={modal === 'new'}
        onClose={() => setModal('none')}
        onCreated={handleOpen}
      />
      <OpenFolderDialog
        open={modal === 'open'}
        onClose={() => setModal('none')}
        onImported={handleOpen}
      />
    </main>
  );
}
