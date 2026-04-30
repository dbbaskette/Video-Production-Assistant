import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api.js';

interface Props {
  open: boolean;
  onClose: () => void;
  onImported: (id: string) => void;
}

export function OpenFolderDialog({ open, onClose, onImported }: Props) {
  const queryClient = useQueryClient();
  const [path, setPath] = useState('');

  const importMutation = useMutation({
    mutationFn: () => api.importProject({ path }),
    onSuccess: (project) => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      onImported(project.id);
      setPath('');
      onClose();
    },
  });

  if (!open) return null;
  const error = importMutation.error;
  const errorMsg =
    error instanceof ApiError ? error.message : error instanceof Error ? error.message : null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 8,
          padding: 24, width: 520, maxWidth: '90vw',
        }}
      >
        <h2 style={{ marginTop: 0 }}>Open existing project folder</h2>
        <p style={{ fontSize: 13, color: 'var(--fg-muted)', marginTop: 0 }}>
          Paste an absolute path to a folder containing <code>project.yaml</code>.
        </p>
        <input
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="/Users/me/Movies/VPA/my-demo"
          autoFocus
          style={{ width: '100%', marginBottom: 12 }}
        />
        {errorMsg && (
          <div style={{ color: 'var(--danger)', marginBottom: 12, fontSize: 13 }}>{errorMsg}</div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onClose} disabled={importMutation.isPending}>Cancel</button>
          <button
            className="primary"
            disabled={!path.trim() || importMutation.isPending}
            onClick={() => importMutation.mutate()}
          >
            {importMutation.isPending ? 'Importing…' : 'Open'}
          </button>
        </div>
      </div>
    </div>
  );
}
