import { useState, useEffect } from 'react';
import { useMutation, useQueryClient, useQuery } from '@tanstack/react-query';
import { api, ApiError, brandsApi } from '../lib/api.js';
import { BrandPicker } from './BrandPicker.js';

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}

export function NewProjectDialog({ open, onClose, onCreated }: Props) {
  const queryClient = useQueryClient();
  const defaults = useQuery({ queryKey: ['defaults'], queryFn: api.getDefaults });
  const brandsQuery = useQuery({ queryKey: ['brands'], queryFn: () => brandsApi.list() });
  const [name, setName] = useState('');
  const [parentDir, setParentDir] = useState('');
  const [objective, setObjective] = useState('');
  const [brand, setBrand] = useState<{ id: string; applied_version: number } | null>(null);

  // Pre-select default brand when brands load
  useEffect(() => {
    if (brandsQuery.data && brand === null) {
      const defaultId = brandsQuery.data.default_brand_id;
      if (defaultId) {
        const entry = brandsQuery.data.brands.find((b) => b.id === defaultId);
        if (entry) {
          setBrand({ id: entry.id, applied_version: entry.version });
        }
      }
    }
  }, [brandsQuery.data, brand]);

  const create = useMutation({
    mutationFn: () =>
      api.createProject({
        name,
        parentDir: parentDir.trim() ? parentDir : undefined,
        objective: objective.trim() ? objective : undefined,
        brand,
      }),
    onSuccess: (project) => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      onCreated(project.id);
      setName('');
      setParentDir('');
      setObjective('');
      setBrand(null);
      onClose();
    },
  });

  if (!open) return null;
  const error = create.error;
  const errorMsg =
    error instanceof ApiError ? error.message : error instanceof Error ? error.message : null;
  const placeholderRoot = defaults.data?.projectsDefault ?? '~/Movies/VPA';
  const nameValid = /^[a-zA-Z0-9_-]+$/.test(name) && name.length > 0;

  return (
    <div
      className="dialog-overlay"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h2>New project</h2>

        <div className="dialog__field">
          <label className="dialog__label">Name (alphanumeric, dash, underscore)</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my-demo"
            autoFocus
            style={{ width: '100%' }}
          />
        </div>

        <div className="dialog__field">
          <label className="dialog__label">Parent directory (optional)</label>
          <input
            value={parentDir}
            onChange={(e) => setParentDir(e.target.value)}
            placeholder={placeholderRoot}
            style={{ width: '100%' }}
          />
        </div>

        <div className="dialog__field">
          <label className="dialog__label">Objective (optional)</label>
          <textarea
            value={objective}
            onChange={(e) => setObjective(e.target.value)}
            rows={3}
            placeholder="What is this demo showing?"
            style={{ width: '100%', resize: 'vertical' }}
          />
        </div>

        <div className="dialog__field">
          <label className="dialog__label">Brand</label>
          <BrandPicker value={brand} onChange={setBrand} />
        </div>

        {errorMsg && (
          <div style={{ color: 'var(--danger)', fontSize: 13 }}>{errorMsg}</div>
        )}

        <div className="dialog__actions">
          <button onClick={onClose} disabled={create.isPending}>Cancel</button>
          <button
            className="primary"
            disabled={!nameValid || create.isPending}
            onClick={() => create.mutate()}
          >
            {create.isPending ? 'Creating...' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}
