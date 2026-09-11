import { useRef, useState, useEffect, useId } from 'react';
import { useQueryClient, useQuery } from '@tanstack/react-query';
import { Lightbulb, Presentation, Video } from 'lucide-react';
import { api, ApiError, brandsApi, presentationsApi, sourceDocsApi, type SourceDoc, type UploadProgress } from '../lib/api.js';
import { BrandPicker } from './BrandPicker.js';
import { CreateProgressModal, type CreateStage } from './CreateProgressModal.js';
import { useUnsavedGuard } from './ui/useUnsavedGuard.js';
import { PresentationFilePicker } from './PresentationFilePicker.js';
import { useModalFocus } from './ui/useModalFocus.js';

/**
 * The Dashboard has two hero cards that both end up here:
 *   - "Ideate a new demo"   → mode 'ideate'  → routed to /ideation
 *   - "I have recordings"   → mode 'recordings' → routed to /recordings
 *
 * The form fields are identical across modes, but the user reasonably
 * expects to know which path they're on. The `mode` prop drives the
 * dialog's heading + lead paragraph + Create button label so there's
 * no ambiguity inside the modal itself.
 */
export type NewProjectMode = 'ideate' | 'recordings' | 'presentation';

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string, result?: { presentationId: string }) => void;
  mode?: NewProjectMode;
}

const COPY_BY_MODE: Record<
  NewProjectMode,
  { heading: string; lead: string; createLabel: string }
> = {
  ideate: {
    heading: 'Ideate a new demo',
    lead: 'Describe what you want to demo and (optionally) drop reference docs. After you create the project, the AI will propose a storyboard you can refine.',
    createLabel: 'Create & start ideating',
  },
  recordings: {
    heading: 'New project from recordings',
    lead: 'Create the project shell first; you\'ll upload your existing MP4s on the next screen and we\'ll auto-build a storyboard with one scene per file.',
    createLabel: 'Create & upload recordings',
  },
  presentation: {
    heading: 'Create a narrated presentation',
    lead: 'Upload a PDF deck. VPA creates one scene per slide and can draft narration for each one.',
    createLabel: 'Create & import presentation',
  },
};

export function NewProjectDialog({ open, onClose, onCreated, mode = 'ideate' }: Props) {
  const copy = COPY_BY_MODE[mode];
  const headingId = useId();
  const queryClient = useQueryClient();
  const defaults = useQuery({ queryKey: ['defaults'], queryFn: api.getDefaults });
  const brandsQuery = useQuery({ queryKey: ['brands'], queryFn: () => brandsApi.list() });
  const [rawName, setRawName] = useState('');
  const [parentDir, setParentDir] = useState('');
  const [objective, setObjective] = useState('');
  const [brand, setBrand] = useState<{ id: string; applied_version: number } | null>(null);
  const [pendingDocs, setPendingDocs] = useState<File[]>([]);
  const [presentationFile, setPresentationFile] = useState<File | null>(null);
  const [presentationPreviewValid, setPresentationPreviewValid] = useState(false);
  const [generateNarration, setGenerateNarration] = useState(true);
  const [createdPresentationProjectId, setCreatedPresentationProjectId] = useState<string | null>(null);
  const [presentationUploadError, setPresentationUploadError] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);
  const openRef = useRef(open);
  const sessionRef = useRef(0);

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

  // Create orchestration. With no reference docs it's a single fast call and
  // we navigate immediately. With docs, we surface a progress modal: the
  // upload registers the files fast (extraction runs in the background), then
  // we poll the doc list so the user can watch extraction finish — or hit
  // "Continue in background" and jump straight into the project.
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [createError, setCreateError] = useState<unknown>(null);
  const [progress, setProgress] = useState<{
    projectId: string | null;
    stage: CreateStage;
    docs: SourceDoc[];
    totalDocs: number;
    error?: string;
  } | null>(null);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const navigatedRef = useRef(false);

  useEffect(() => {
    // Clear any live poll if the dialog unmounts.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      sessionRef.current += 1;
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const resetForm = () => {
    setRawName('');
    setParentDir('');
    setObjective('');
    setBrand(null);
    setPendingDocs([]);
    setPresentationFile(null);
    setPresentationPreviewValid(false);
    setGenerateNarration(true);
    setCreatedPresentationProjectId(null);
    setPresentationUploadError(false);
  };

  useEffect(() => {
    openRef.current = open;
    sessionRef.current += 1;
    if (open) return;
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
    resetForm();
    setCreateError(null);
    setProgress(null);
    setBusy(false);
    busyRef.current = false;
    navigatedRef.current = false;
  }, [open]);

  const sessionIsCurrent = (session: number) => (
    mountedRef.current && openRef.current && sessionRef.current === session
  );

  const navigateToProject = (projectId: string) => {
    if (navigatedRef.current) return;
    navigatedRef.current = true;
    sessionRef.current += 1;
    if (pollRef.current) clearInterval(pollRef.current);
    queryClient.invalidateQueries({ queryKey: ['projects'] });
    resetForm();
    setProgress(null);
    setBusy(false);
    busyRef.current = false;
    onCreated(projectId);
    onClose();
  };

  const pollExtraction = (projectId: string, session: number) => {
    if (pollRef.current) clearInterval(pollRef.current);
    let polling = false;
    pollRef.current = setInterval(async () => {
      if (polling) return;
      polling = true;
      try {
        const docs = await sourceDocsApi.list(projectId);
        if (!sessionIsCurrent(session)) return;
        const stillExtracting = docs.some((d) => d.status === 'extracting');
        setProgress((p) =>
          p ? { ...p, docs, stage: stillExtracting ? 'extracting' : 'done' } : p,
        );
        if (!stillExtracting && pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
      } catch {
        // Transient list failure — keep polling; the user can always
        // "Continue in background".
      } finally {
        polling = false;
      }
    }, 1000);
  };

  const runCreate = async () => {
    if (!canCreate || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setCreateError(null);
    setPresentationUploadError(false);
    navigatedRef.current = false;
    const session = sessionRef.current;

    if (mode === 'presentation' && createdPresentationProjectId) {
      await uploadPresentation(createdPresentationProjectId, session);
      return;
    }

    const hasDocs = pendingDocs.length > 0;
    if (hasDocs) {
      setProgress({ projectId: null, stage: 'creating', docs: [], totalDocs: pendingDocs.length });
    }

    let projectId: string;
    try {
      const project = await api.createProject({
        name: slug,
        parentDir: parentDir.trim() ? parentDir : undefined,
        objective: objective.trim() ? objective : undefined,
        brand,
      });
      projectId = project.id;
    } catch (err) {
      if (!sessionIsCurrent(session)) return;
      // Project creation itself failed — no modal, show inline error.
      setCreateError(err);
      setProgress(null);
      setBusy(false);
      busyRef.current = false;
      return;
    }

    if (!sessionIsCurrent(session)) return;

    if (mode === 'presentation') {
      setCreatedPresentationProjectId(projectId);
      await uploadPresentation(projectId, session);
      return;
    }

    if (!hasDocs) {
      navigateToProject(projectId);
      return;
    }

    setProgress((p) => (p ? { ...p, projectId, stage: 'uploading' } : p));
    try {
      const { created } = await sourceDocsApi.uploadFiles(projectId, pendingDocs, {
        onProgress: setUploadProgress,
      });
      if (!sessionIsCurrent(session)) return;
      const stillExtracting = created.some((d) => d.status === 'extracting');
      setProgress((p) =>
        p ? { ...p, projectId, docs: created, stage: stillExtracting ? 'extracting' : 'done' } : p,
      );
      if (stillExtracting) {
        pollExtraction(projectId, session);
      }
    } catch (err) {
      if (!sessionIsCurrent(session)) return;
      // Upload failed — the project exists, so let the user proceed anyway.
      setProgress((p) =>
        p
          ? {
              ...p,
              projectId,
              stage: 'error',
              error: err instanceof Error ? err.message : 'Upload failed',
            }
          : p,
      );
    }
  };

  const uploadPresentation = async (projectId: string, session: number) => {
    if (!presentationFile || !presentationPreviewValid) {
      setBusy(false);
      busyRef.current = false;
      return;
    }
    try {
      const job = await presentationsApi.upload(projectId, presentationFile, generateNarration, {
        onProgress: setUploadProgress,
      });
      if (!sessionIsCurrent(session)) return;
      if (navigatedRef.current) return;
      navigatedRef.current = true;
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      resetForm();
      setBusy(false);
      busyRef.current = false;
      onCreated(projectId, { presentationId: job.id });
      onClose();
    } catch {
      if (!sessionIsCurrent(session)) return;
      setPresentationUploadError(true);
      setBusy(false);
      busyRef.current = false;
    } finally {
      setUploadProgress(null);
    }
  };

  const openEmptyPresentationProject = () => {
    if (!createdPresentationProjectId || navigatedRef.current) return;
    navigatedRef.current = true;
    const projectId = createdPresentationProjectId;
    queryClient.invalidateQueries({ queryKey: ['projects'] });
    resetForm();
    setBusy(false);
    busyRef.current = false;
    onCreated(projectId);
    onClose();
  };

  // Guard against losing typed input on overlay-click or Cancel. Considers
  // any of (name, objective, parent dir, queued docs) as "unsaved".
  const hasUnsavedChanges =
    rawName.trim().length > 0 ||
    objective.trim().length > 0 ||
    parentDir.trim().length > 0 ||
    pendingDocs.length > 0 ||
    presentationFile !== null ||
    generateNarration !== true ||
    createdPresentationProjectId !== null;
  const discardAndClose = () => {
    sessionRef.current += 1;
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
    resetForm();
    setCreateError(null);
    setProgress(null);
    setBusy(false);
    busyRef.current = false;
    navigatedRef.current = false;
    onClose();
  };
  const guardedClose = useUnsavedGuard({
    hasUnsavedChanges,
    message: createdPresentationProjectId
      ? 'Discard this import setup? The empty project will remain, but the selected PDF and local import choices will be cleared.'
      : mode === 'presentation'
        ? 'Discard this project setup? The project name, selected PDF, and local import choices will be cleared.'
        : 'Discard the project info you typed? Your name, objective, parent directory, and queued reference docs will be lost.',
    onConfirmDiscard: discardAndClose,
  });

  useModalFocus({
    open: open && !progress,
    dialogRef,
    initialFocusRef: nameInputRef,
    escapeDisabled: busy,
    onEscape: guardedClose,
  });

  if (!open) return null;
  const errorMsg =
    createError instanceof ApiError
      ? createError.message
      : createError instanceof Error
        ? createError.message
        : null;
  const placeholderRoot = defaults.data?.projectsDefault ?? '~/Movies/VPA';
  const nameValid = slug.length > 0;
  const canCreate = nameValid
    && (mode !== 'presentation' || (!!presentationFile && presentationPreviewValid));
  const nameInvalidReason =
    rawName.length === 0
      ? null
      : slug.length === 0
        ? 'Use letters, numbers, dashes, or underscores.'
        : null;

  return (
    <div
      className="dialog-overlay"
      onClick={() => { if (!busy) guardedClose(); }}
    >
      <div
        ref={dialogRef}
        className={`dialog${mode === 'presentation' ? ' presentation-dialog' : ''}`}
        role={progress ? undefined : 'dialog'}
        aria-modal={progress ? undefined : 'true'}
        aria-labelledby={headingId}
        aria-busy={busy}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Heading row — Lucide icon + serif h2 reads as editorial without
            leaning on emoji. Mode-coloured (accent for ideate / fg-muted
            for recordings) so the user can tell visually which path. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          {mode === 'ideate' ? (
            <Lightbulb size={20} strokeWidth={1.6} color="var(--accent)" aria-hidden />
          ) : mode === 'recordings' ? (
            <Video size={20} strokeWidth={1.6} color="var(--accent)" aria-hidden />
          ) : (
            <Presentation size={20} strokeWidth={1.6} color="var(--accent)" aria-hidden />
          )}
          <h2 id={headingId} style={{ margin: 0 }}>{copy.heading}</h2>
        </div>
        <p style={{ margin: '0 0 18px', fontSize: 13, color: 'var(--fg-muted)', lineHeight: 1.5 }}>
          {copy.lead}
        </p>

        <div className="dialog__field">
          <label className="dialog__label">Name</label>
          <input
            ref={nameInputRef}
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

        <details className="project-directory-options"><summary>Project folder (optional)</summary><div className="dialog__field">
          <label className="dialog__label">Parent directory (optional)</label>
          <input
            value={parentDir}
            onChange={(e) => setParentDir(e.target.value)}
            placeholder={placeholderRoot}
            style={{ width: '100%' }}
          />
        </div></details>

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

        {mode === 'presentation' && (
          <>
            <div className="dialog__field">
              <label className="dialog__label">Presentation PDF</label>
              <PresentationFilePicker
                file={presentationFile}
                disabled={busy}
                onChange={(file) => {
                  setPresentationFile(file);
                  setPresentationPreviewValid(false);
                  if (!createdPresentationProjectId) setPresentationUploadError(false);
                }}
                onPreviewChange={({ valid }) => setPresentationPreviewValid(valid)}
              />
            </div>
            <label className="presentation-dialog__narration">
              <input
                type="checkbox"
                checked={generateNarration}
                disabled={busy}
                onChange={(event) => setGenerateNarration(event.currentTarget.checked)}
              />
              Generate draft narration
            </label>
            <p className="presentation-dialog__note">
              Slide animations and embedded media become static images.
            </p>
          </>
        )}

        {mode !== 'presentation' && <div className="dialog__field">
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
        </div>}

        {errorMsg && (
          <div style={{ color: 'var(--danger)', fontSize: 13 }}>{errorMsg}</div>
        )}
        {presentationUploadError && (
          <p className="presentation-file-picker__error" role="alert">
            The PDF could not be uploaded. Try the upload again, choose another PDF, or open the empty project.
          </p>
        )}

        <div className="dialog__actions">
          <button onClick={guardedClose} disabled={busy}>Cancel</button>
          {presentationUploadError && createdPresentationProjectId && (
            <button type="button" onClick={openEmptyPresentationProject} disabled={busy}>
              Open empty project
            </button>
          )}
          <button
            className="primary"
            disabled={!canCreate || busy}
            onClick={() => runCreate()}
            title={!nameValid ? 'Enter a project name' : mode === 'presentation' && !canCreate ? 'Choose a valid PDF and wait for its preview' : undefined}
          >
            {busy
              ? createdPresentationProjectId ? 'Uploading…' : 'Creating…'
              : presentationUploadError ? 'Try upload again' : copy.createLabel}
          </button>
        </div>
      </div>

      {progress && (
        <CreateProgressModal
          stage={progress.stage}
          totalDocs={progress.totalDocs}
          docs={progress.docs}
          error={progress.error}
          uploadProgress={uploadProgress}
          onContinueBackground={() => {
            if (progress.projectId) navigateToProject(progress.projectId);
          }}
          onClose={() => {
            if (pollRef.current) clearInterval(pollRef.current);
            setProgress(null);
            setBusy(false);
            busyRef.current = false;
          }}
        />
      )}
    </div>
  );
}
