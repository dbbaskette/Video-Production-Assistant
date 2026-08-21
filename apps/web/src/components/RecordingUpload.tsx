import { useState, useRef, type DragEvent } from 'react';
import type { UploadProgress } from '../lib/api.js';

interface RecordingUploadProps {
  onFilesSelected: (files: File[]) => void;
  isUploading?: boolean;
  /** Byte-level progress for the in-flight upload; null fraction = indeterminate. */
  progress?: UploadProgress | null;
  multiple?: boolean;
}

export function RecordingUpload({ onFilesSelected, isUploading, progress, multiple = true }: RecordingUploadProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [ignoredCount, setIgnoredCount] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => setIsDragging(false);

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const dropped = Array.from(e.dataTransfer.files);
    const files = dropped.filter((f) => f.type.startsWith('video/') || f.name.endsWith('.mp4'));
    setIgnoredCount(dropped.length - files.length);
    if (files.length > 0) onFilesSelected(files);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) onFilesSelected(files);
    if (inputRef.current) inputRef.current.value = '';
  };

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onClick={() => !isUploading && inputRef.current?.click()}
      style={{
        border: `2px dashed ${isDragging ? 'var(--accent)' : 'var(--border)'}`,
        borderRadius: 12,
        padding: '40px 24px',
        textAlign: 'center',
        cursor: isUploading ? 'wait' : 'pointer',
        background: isDragging ? 'var(--accent-bg)' : 'transparent',
        transition: 'all 0.2s',
        opacity: isUploading ? 0.6 : 1,
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept="video/mp4,.mp4"
        multiple={multiple}
        onChange={handleFileChange}
        style={{ display: 'none' }}
      />
      <div style={{ fontSize: 36, marginBottom: 8 }}>🎬</div>
      {isUploading ? (
        <>
          <p style={{ color: 'var(--fg-muted)', margin: 0 }}>
            Uploading…{progress?.fraction != null ? ` ${Math.round(progress.fraction * 100)}%` : ''}
          </p>
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress?.fraction != null ? Math.round(progress.fraction * 100) : undefined}
            style={{
              width: '60%',
              maxWidth: 320,
              height: 6,
              margin: '12px auto 0',
              background: 'var(--border)',
              borderRadius: 3,
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                width: progress?.fraction != null ? `${Math.round(progress.fraction * 100)}%` : '40%',
                height: '100%',
                background: 'var(--accent)',
                transition: 'width 200ms',
                ...(progress?.fraction == null
                  ? { animation: 'jobTrayIndeterminate 1.4s ease-in-out infinite' }
                  : {}),
              }}
            />
          </div>
        </>
      ) : (
        <>
          <p style={{ margin: 0, fontWeight: 600 }}>
            Drop MP4 files here or click to browse
          </p>
          <p style={{ color: 'var(--fg-muted)', margin: '8px 0 0', fontSize: 13 }}>
            {multiple ? 'Upload one or more .mp4 recordings' : 'Upload a single .mp4 recording'}
          </p>
          {ignoredCount > 0 && (
            <p style={{ color: 'var(--warn)', margin: '8px 0 0', fontSize: 12 }} role="status">
              Ignored {ignoredCount} unsupported file{ignoredCount === 1 ? '' : 's'} — only video files can be used as recordings.
            </p>
          )}
        </>
      )}
    </div>
  );
}
