import { useRef, useState, useEffect } from 'react';
import { useMutation, useQueryClient, useQuery } from '@tanstack/react-query';
import { api, ApiError, brandsApi, sourceDocsApi } from '../lib/api.js';
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
  const [pendingDocs, setPendingDocs] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
    mutationFn: async () => {
      const project = await api.createProject({
        name,
        parentDir: parentDir.trim() ? parentDir : undefined,
        objective: objective.trim() ? objective : undefined,
        brand,
      });
      // Upload any reference docs queued up before clicking Create. Failures
      // here surface as warnings — the project itself is fine, the docs can
      // be re-added from the Project Overview.
      if (pendingDocs.length > 0) {
        try {
          await sourceDocsApi.uploadFiles(project.id, pendingDocs);
        } catch (err) {
          // Swallow; toast on the next page tells the user
          console.warn('Source-doc upload failed during project create:', err);
        }
      }
      return project;
    },
    onSuccess: (project) => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      onCreated(project.id);
      setName('');
      setParentDir('');
      setObjective('');
      setBrand(null);
      setPendingDocs([]);
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

        <div className="dialog__field">
          <label className="dialog__label">
            Reference docs (optional) — used as AI context for every generated line
          </label>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".pdf,.md,.markdown,.txt,.docx,.html,.htm,.yaml,.yml"
            style={{ display: 'none' }}
            onChange={(e) => {
              const list = e.target.files;
              if (!list) return;
              setPendingDocs((prev) => [...prev, ...Array.from(list)]);
              e.target.value = '';
            }}
          />
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              style={{ padding: '6px 12px', fontSize: 13 }}
            >
              + Add files
            </button>
            <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
              {pendingDocs.length === 0
                ? 'PDFs, markdown, plain text, docx — extracted on create'
                : `${pendingDocs.length} file${pendingDocs.length === 1 ? '' : 's'} ready`}
            </span>
          </div>
          {pendingDocs.length > 0 && (
            <ul style={{ margin: '8px 0 0', padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 4 }}>
              {pendingDocs.map((f, idx) => (
                <li
                  key={`${f.name}-${idx}`}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    fontSize: 12,
                    color: 'var(--fg-muted)',
                    padding: '4px 8px',
                    background: 'var(--bg-elev)',
                    borderRadius: 4,
                  }}
                >
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    📄 {f.name} <span style={{ opacity: 0.7 }}>({Math.round(f.size / 1024)} KB)</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => setPendingDocs((prev) => prev.filter((_, i) => i !== idx))}
                    aria-label={`Remove ${f.name}`}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      color: 'var(--fg-muted)',
                      cursor: 'pointer',
                      padding: '0 4px',
                    }}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
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
