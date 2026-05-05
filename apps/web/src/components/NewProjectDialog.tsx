import { useRef, useState, useEffect } from 'react';
import { useMutation, useQueryClient, useQuery } from '@tanstack/react-query';
import { api, ApiError, brandsApi, sourceDocsApi } from '../lib/api.js';
import { BrandPicker } from './BrandPicker.js';
import { useUnsavedGuard } from './ui/useUnsavedGuard.js';

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}

export function NewProjectDialog({ open, onClose, onCreated }: Props) {
  const queryClient = useQueryClient();
  const defaults = useQuery({ queryKey: ['defaults'], queryFn: api.getDefaults });
  const brandsQuery = useQuery({ queryKey: ['brands'], queryFn: () => brandsApi.list() });
  const [rawName, setRawName] = useState('');
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

  // Project names must be filesystem-safe (alphanumeric, dash, underscore)
  // because they become a directory name. Auto-slugify so the UI is forgiving
  // when users type with spaces / punctuation, but still show them what
  // we'll actually save.
  const slug = rawName
    .trim()
    .replace(/\s+/g, '-')        // spaces → dashes
    .replace(/[^a-zA-Z0-9_-]/g, '') // strip anything else
    .replace(/^-+|-+$/g, '');     // no leading/trailing dashes
  const slugDiffers = slug !== rawName.trim() && rawName.length > 0;

  const create = useMutation({
    mutationFn: async () => {
      const project = await api.createProject({
        name: slug,
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
      setRawName('');
      setParentDir('');
      setObjective('');
      setBrand(null);
      setPendingDocs([]);
      onClose();
    },
  });

  // Guard against losing typed input on overlay-click or Cancel. Considers
  // any of (name, objective, parent dir, queued docs) as "unsaved".
  const hasUnsavedChanges =
    rawName.trim().length > 0 ||
    objective.trim().length > 0 ||
    parentDir.trim().length > 0 ||
    pendingDocs.length > 0;
  const guardedClose = useUnsavedGuard({
    hasUnsavedChanges,
    message:
      'Discard the project info you typed? Your name, objective, parent directory, and queued reference docs will be lost.',
    onConfirmDiscard: onClose,
  });

  if (!open) return null;
  const error = create.error;
  const errorMsg =
    error instanceof ApiError ? error.message : error instanceof Error ? error.message : null;
  const placeholderRoot = defaults.data?.projectsDefault ?? '~/Movies/VPA';
  const nameValid = slug.length > 0;
  const nameInvalidReason =
    rawName.length === 0
      ? null
      : slug.length === 0
        ? 'Use letters, numbers, dashes, or underscores.'
        : null;

  return (
    <div
      className="dialog-overlay"
      role="dialog"
      aria-modal="true"
      onClick={guardedClose}
    >
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h2>New project</h2>

        <div className="dialog__field">
          <label className="dialog__label">Name</label>
          <input
            value={rawName}
            onChange={(e) => setRawName(e.target.value)}
            placeholder="MCP Demo Test"
            autoFocus
            style={{ width: '100%' }}
          />
          {/* Live feedback: when the typed name needed cleaning, show what
              we'll actually save; when it strips to empty, explain why. */}
          {nameInvalidReason ? (
            <div style={{ fontSize: 12, color: 'var(--danger)', marginTop: 4 }}>
              {nameInvalidReason}
            </div>
          ) : slugDiffers ? (
            <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 4 }}>
              Will save as <code style={{ color: 'var(--fg)' }}>{slug}</code> (folder name).
            </div>
          ) : (
            <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginTop: 4 }}>
              Becomes a folder under your projects directory.
            </div>
          )}
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
              if (!list || list.length === 0) return;
              // Snapshot the files BEFORE clearing the input. setPendingDocs
              // takes a functional updater whose callback runs later — by
              // then `e.target.files` is empty and the spread would be a
              // no-op. (Symptom: had to pick a file twice.)
              const picked = Array.from(list);
              e.target.value = '';
              setPendingDocs((prev) => [...prev, ...picked]);
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
          <button onClick={guardedClose} disabled={create.isPending}>Cancel</button>
          <button
            className="primary"
            disabled={!nameValid || create.isPending}
            onClick={() => create.mutate()}
            title={!nameValid ? 'Enter a project name to enable Create' : undefined}
          >
            {create.isPending ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}
