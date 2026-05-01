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
      className="dialog-overlay"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h2>Open existing project</h2>
        <p style={{ fontSize: 13, color: 'var(--fg-muted)', margin: '0 0 16px' }}>
          Paste an absolute path to a folder containing <code>project.yaml</code>.
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
          <button onClick={onClose} disabled={importMutation.isPending}>Cancel</button>
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
