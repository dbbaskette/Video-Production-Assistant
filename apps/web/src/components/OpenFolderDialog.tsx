import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api.js';
import { useUnsavedGuard } from './ui/useUnsavedGuard.js';

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

  // Protect typed-but-not-imported path from a misclick.
  const guardedClose = useUnsavedGuard({
    hasUnsavedChanges: path.trim().length > 0,
    message: 'Discard the path you typed?',
    onConfirmDiscard: onClose,
  });

  if (!open) return null;
  const error = importMutation.error;
  const errorMsg =
    error instanceof ApiError ? error.message : error instanceof Error ? error.message : null;

  return (
    <div
      className="dialog-overlay"
      role="dialog"
      aria-modal="true"
      onClick={guardedClose}
    >
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h2>Open existing project</h2>
        <p style={{ fontSize: 13, color: 'var(--fg-muted)', margin: '0 0 16px' }}>
          Open a project previously created by VPA. Choose its top-level project folder, which contains the project and its media. To start from loose videos or a PDF, create a new project instead.
        </p>

        <div className="dialog__field">
          <label className="dialog__label">Project folder path</label>
          <input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="/Users/me/Movies/VPA/my-demo"
            autoFocus
            style={{ width: '100%' }}
          />
        </div>

        {errorMsg && (
          <div style={{ color: 'var(--danger)', fontSize: 13 }}>{errorMsg}</div>
        )}

        <div className="dialog__actions">
          <button onClick={guardedClose} disabled={importMutation.isPending}>Cancel</button>
          <button
            className="primary"
            disabled={!path.trim() || importMutation.isPending}
            onClick={() => importMutation.mutate()}
          >
            {importMutation.isPending ? 'Importing...' : 'Open'}
          </button>
        </div>
      </div>
    </div>
  );
}
