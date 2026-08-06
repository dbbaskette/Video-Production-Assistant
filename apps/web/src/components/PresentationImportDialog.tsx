import { useEffect, useId, useRef, useState } from 'react';
import type { PresentationJob } from '@vpa/shared';
import { presentationsApi } from '../lib/api.js';
import { PresentationFilePicker } from './PresentationFilePicker.js';

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
  const [file, setFile] = useState<File | null>(null);
  const [previewValid, setPreviewValid] = useState(false);
  const [generateNarration, setGenerateNarration] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (open) return;
    acceptedRef.current = false;
    uploadingRef.current = false;
    setFile(null);
    setPreviewValid(false);
    setGenerateNarration(true);
    setUploading(false);
    setError(false);
  }, [open]);

  if (!open) return null;

  const upload = async () => {
    if (!file || !previewValid || uploadingRef.current || acceptedRef.current) return;
    uploadingRef.current = true;
    setUploading(true);
    setError(false);
    try {
      const job = await presentationsApi.upload(projectId, file, generateNarration);
      if (!mountedRef.current) return;
      if (acceptedRef.current) return;
      acceptedRef.current = true;
      onAccepted(job);
      onClose();
    } catch {
      if (!mountedRef.current) return;
      uploadingRef.current = false;
      setError(true);
      setUploading(false);
    }
  };

  return (
    <div
      className="dialog-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby={headingId}
      onClick={() => { if (!uploading) onClose(); }}
    >
      <div className="dialog presentation-dialog" onClick={(event) => event.stopPropagation()}>
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
          <button type="button" disabled={uploading} onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="primary"
            disabled={!file || !previewValid || uploading}
            onClick={() => void upload()}
          >
            {uploading ? 'Adding…' : 'Add presentation'}
          </button>
        </div>
      </div>
    </div>
  );
}
