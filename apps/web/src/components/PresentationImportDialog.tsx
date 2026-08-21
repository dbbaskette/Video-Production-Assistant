import { useEffect, useId, useRef, useState } from 'react';
import type { PresentationJob } from '@vpa/shared';
import { presentationsApi, type UploadProgress } from '../lib/api.js';
import { PresentationFilePicker } from './PresentationFilePicker.js';
import { useModalFocus } from './ui/useModalFocus.js';

export interface PresentationImportDialogProps {
  projectId: string;
  open: boolean;
  onAccepted(job: PresentationJob): void;
  onClose(): void;
}

export function PresentationImportDialog({
  projectId,
  open,
  onAccepted,
  onClose,
}: PresentationImportDialogProps) {
  const headingId = useId();
  const acceptedRef = useRef(false);
  const uploadingRef = useRef(false);
  const mountedRef = useRef(true);
  const openRef = useRef(open);
  const sessionRef = useRef(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [previewValid, setPreviewValid] = useState(false);
  const [generateNarration, setGenerateNarration] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      sessionRef.current += 1;
    };
  }, []);

  useEffect(() => {
    openRef.current = open;
    sessionRef.current += 1;
    if (open) return;
    acceptedRef.current = false;
    uploadingRef.current = false;
    setFile(null);
    setPreviewValid(false);
    setGenerateNarration(true);
    setUploading(false);
    setError(false);
  }, [open]);

  useModalFocus({
    open,
    dialogRef,
    initialFocusRef: cancelRef,
    escapeDisabled: uploading,
    onEscape: onClose,
  });

  if (!open) return null;

  const upload = async () => {
    if (!file || !previewValid || uploadingRef.current || acceptedRef.current) return;
    uploadingRef.current = true;
    const session = sessionRef.current;
    setUploading(true);
    setError(false);
    try {
      const job = await presentationsApi.upload(projectId, file, generateNarration, {
        onProgress: setProgress,
      });
      if (!mountedRef.current || !openRef.current || sessionRef.current !== session) return;
      if (acceptedRef.current) return;
      acceptedRef.current = true;
      onAccepted(job);
      onClose();
    } catch {
      if (!mountedRef.current || !openRef.current || sessionRef.current !== session) return;
      uploadingRef.current = false;
      setError(true);
      setUploading(false);
    } finally {
      setProgress(null);
    }
  };

  return (
    <div
      className="dialog-overlay"
      onClick={() => { if (!uploading) onClose(); }}
    >
      <div
        ref={dialogRef}
        className="dialog presentation-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        aria-busy={uploading}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id={headingId}>Add a presentation</h2>
        <p className="presentation-dialog__lead">
          Upload a PDF to add one narratable scene per slide. A revised deck adds new scenes.
        </p>
        <PresentationFilePicker
          file={file}
          disabled={uploading}
          onChange={(next) => {
            setFile(next);
            setPreviewValid(false);
            setError(false);
          }}
          onPreviewChange={({ valid }) => setPreviewValid(valid)}
        />
        <label className="presentation-dialog__narration">
          <input
            type="checkbox"
            checked={generateNarration}
            disabled={uploading}
            onChange={(event) => setGenerateNarration(event.currentTarget.checked)}
          />
          Generate draft narration
        </label>
        <p className="presentation-dialog__note">
          Slide animations and embedded media become static images.
        </p>
        {error && (
          <p className="presentation-file-picker__error" role="alert">
            The PDF could not be added. Try the upload again or choose another PDF.
          </p>
        )}
        <div className="dialog__actions presentation-dialog__actions">
          <button ref={cancelRef} type="button" disabled={uploading} onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="primary"
            disabled={!file || !previewValid || uploading}
            onClick={() => void upload()}
          >
            {uploading
              ? `Adding…${progress?.fraction != null ? ` ${Math.round(progress.fraction * 100)}%` : ''}`
              : 'Add presentation'}
          </button>
        </div>
      </div>
    </div>
  );
}
