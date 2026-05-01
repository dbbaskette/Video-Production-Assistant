import { useState, useRef, type DragEvent } from 'react';

interface RecordingUploadProps {
  onFilesSelected: (files: File[]) => void;
  isUploading?: boolean;
  multiple?: boolean;
}

export function RecordingUpload({ onFilesSelected, isUploading, multiple = true }: RecordingUploadProps) {
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => setIsDragging(false);

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const files = Array.from(e.dataTransfer.files).filter((f) =>
      f.type.startsWith('video/') || f.name.endsWith('.mp4'),
    );
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
        <p style={{ color: 'var(--fg-muted)', margin: 0 }}>Uploading…</p>
      ) : (
        <>
          <p style={{ margin: 0, fontWeight: 600 }}>
            Drop MP4 files here or click to browse
          </p>
          <p style={{ color: 'var(--fg-muted)', margin: '8px 0 0', fontSize: 13 }}>
            {multiple ? 'Upload one or more .mp4 recordings' : 'Upload a single .mp4 recording'}
          </p>
        </>
      )}
    </div>
  );
}
