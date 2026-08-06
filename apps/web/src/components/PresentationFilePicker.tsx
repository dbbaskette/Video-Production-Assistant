import { useEffect, useId, useRef, useState } from 'react';
import {
  PresentationPreviewError,
  previewPresentation,
  startPresentationPreview,
  type PresentationPreview,
  type PresentationPreviewOperation,
} from '../lib/presentation-preview.js';

export interface PresentationFilePickerProps {
  file: File | null;
  disabled?: boolean;
  onChange(file: File | null): void;
  onPreviewChange?(state: {
    valid: boolean;
    preview: PresentationPreview | null;
  }): void;
}

type PreviewState =
  | { kind: 'empty' }
  | { kind: 'loading' }
  | { kind: 'ready'; preview: PresentationPreview }
  | { kind: 'error'; message: string };

export function PresentationFilePicker({
  file,
  disabled = false,
  onChange,
  onPreviewChange,
  startPreview = startResolvedPresentationPreview,
}: PresentationFilePickerProps & {
  /** Test seam for cancellable preview work; application callers use the PDF reader. */
  startPreview?: (file: File) => PresentationPreviewResultOperation;
}) {
  const inputId = useId();
  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  const onPreviewChangeRef = useRef(onPreviewChange);
  const [state, setState] = useState<PreviewState>({ kind: 'empty' });

  onPreviewChangeRef.current = onPreviewChange;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
    };
  }, []);

  useEffect(() => {
    const generation = ++generationRef.current;
    if (!file) {
      setState({ kind: 'empty' });
      onPreviewChangeRef.current?.({ valid: false, preview: null });
      return;
    }

    setState({ kind: 'loading' });
    onPreviewChangeRef.current?.({ valid: false, preview: null });
    const operation = startPreview(file);
    void operation.promise.then((result) => {
      if (!mountedRef.current || generationRef.current !== generation) return;
      if (result.kind === 'superseded') return;
      if (result.kind === 'error') {
        setState({ kind: 'error', message: result.message });
        onPreviewChangeRef.current?.({ valid: false, preview: null });
        return;
      }
      setState({ kind: 'ready', preview: result.preview });
      onPreviewChangeRef.current?.({ valid: true, preview: result.preview });
    });
    return () => operation.cancel();
  }, [file, startPreview]);

  return (
    <div className="presentation-file-picker" aria-busy={state.kind === 'loading'}>
      <input
        id={inputId}
        className="presentation-file-picker__input"
        type="file"
        accept=".pdf"
        aria-label="Presentation PDF"
        disabled={disabled}
        onChange={(event) => {
          const selected = event.currentTarget.files?.[0] ?? null;
          event.currentTarget.value = '';
          if (selected) onChange(selected);
        }}
      />

      {!file ? (
        <label
          className={`presentation-file-picker__choose${disabled ? ' is-disabled' : ''}`}
          htmlFor={inputId}
          aria-disabled={disabled}
        >
          <span className="presentation-file-picker__choose-title">Choose PDF</span>
          <span>Each slide becomes a scene.</span>
        </label>
      ) : (
        <div className="presentation-file-picker__selection">
          <div className="presentation-file-picker__file-row">
            <div className="presentation-file-picker__file-copy">
              <strong title={file.name}>{file.name}</strong>
              <span>
                {formatFileSize(file.size)}
                {state.kind === 'ready'
                  ? ` · ${state.preview.pageCount} ${state.preview.pageCount === 1 ? 'slide' : 'slides'}`
                  : ''}
              </span>
            </div>
            <label className="presentation-file-picker__replace" htmlFor={inputId}>
              Replace PDF
            </label>
            <button
              type="button"
              className="presentation-file-picker__remove"
              aria-label={`Remove ${file.name}`}
              disabled={disabled}
              onClick={() => onChange(null)}
            >
              Remove
            </button>
          </div>

          {state.kind === 'loading' && (
            <p className="presentation-file-picker__status">Reading slides…</p>
          )}
          {state.kind === 'error' && (
            <p className="presentation-file-picker__error" role="alert">
              {state.message}. Choose another PDF to replace this file.
            </p>
          )}
          {state.kind === 'ready' && state.preview.thumbnails.length > 0 && (
            <div className="presentation-contact-sheet" aria-label="Slide previews">
              {state.preview.thumbnails.slice(0, 4).map((thumbnail) => (
                <figure className="presentation-contact-sheet__slide" key={thumbnail.pageNumber}>
                  <img
                    className="presentation-contact-sheet__image"
                    src={thumbnail.dataUrl}
                    alt={`Slide preview ${thumbnail.pageNumber}`}
                  />
                  <figcaption>{String(thumbnail.pageNumber).padStart(2, '0')}</figcaption>
                </figure>
              ))}
              {state.preview.pageCount > 4 && (
                <span className="presentation-contact-sheet__more">
                  +{state.preview.pageCount - 4} more slides
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export type PresentationPreviewResult =
  | { kind: 'ready'; preview: PresentationPreview }
  | { kind: 'error'; message: string }
  | { kind: 'superseded' };

export interface PresentationPreviewResultOperation {
  promise: Promise<PresentationPreviewResult>;
  cancel(): void;
}

export function startResolvedPresentationPreview(file: File): PresentationPreviewResultOperation {
  const operation: PresentationPreviewOperation = startPresentationPreview(file);
  return {
    promise: operation.promise.then(
      (preview) => ({ kind: 'ready', preview }),
      (error: unknown) => normalizePreviewError(error),
    ),
    cancel: operation.cancel,
  };
}

export async function resolvePresentationPreview(
  file: File,
  previewFile: typeof previewPresentation = previewPresentation,
): Promise<PresentationPreviewResult> {
  try {
    return { kind: 'ready', preview: await previewFile(file) };
  } catch (error) {
    return normalizePreviewError(error);
  }
}

function normalizePreviewError(error: unknown): PresentationPreviewResult {
  if (error instanceof PresentationPreviewError && error.code === 'superseded') {
    return { kind: 'superseded' };
  }
  return {
    kind: 'error',
    message: error instanceof PresentationPreviewError
      ? error.message
      : 'This PDF could not be previewed',
  };
}

export function formatFileSize(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  const kilobytes = sizeBytes / 1024;
  if (kilobytes < 1024) return `${roundedSize(kilobytes)} KB`;
  return `${roundedSize(kilobytes / 1024)} MB`;
}

function roundedSize(value: number): string {
  const rounded = value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
  return String(rounded);
}
