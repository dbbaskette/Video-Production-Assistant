import { useState } from 'react';
import { useParams, useOutletContext, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { storyboardApi, recordingsApi, type VideoMetadata } from '../lib/api.js';
import { RecordingUpload } from '../components/RecordingUpload.js';
import type { ProjectTrackerEntry } from '@vpa/shared';

interface WorkspaceContext {
  project: ProjectTrackerEntry;
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type UploadMode = 'idle' | 'bulk' | 'generate';

export function RecordingsPage() {
  const { project } = useOutletContext<WorkspaceContext>();
  const { projectId } = useParams<{ projectId: string }>();
  const queryClient = useQueryClient();

  const [uploadMode, setUploadMode] = useState<UploadMode>('idle');
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);

  const { data: storyboard } = useQuery({
    queryKey: ['storyboard', projectId],
    queryFn: () => storyboardApi.get(projectId!),
    enabled: !!projectId,
  });

  const scenes = storyboard?.scenes ?? [];
  const hasStoryboard = storyboard != null && scenes.length > 0;
  const recordedScenes = scenes.filter((s) => s.recording);

  // Bulk upload: assign recordings to existing storyboard scenes
  const bulkMutation = useMutation({
    mutationFn: (files: File[]) => recordingsApi.uploadBulk(projectId!, files),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['storyboard', projectId] });
      setPendingFiles([]);
      setUploadMode('idle');
    },
  });

  // Generate storyboard from recordings (no storyboard exists yet)
  const generateMutation = useMutation({
    mutationFn: (files: File[]) => recordingsApi.generateStoryboard(projectId!, files),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['storyboard', projectId] });
      setPendingFiles([]);
      setUploadMode('idle');
    },
  });

  const isUploading = bulkMutation.isPending || generateMutation.isPending;
  const error = bulkMutation.error || generateMutation.error;
  const errorMsg = error instanceof Error ? error.message : null;

  const handleFilesSelected = (files: File[]) => {
    setPendingFiles(files);
  };

  const handleUpload = () => {
    if (pendingFiles.length === 0) return;
    if (hasStoryboard) {
      bulkMutation.mutate(pendingFiles);
    } else {
      generateMutation.mutate(pendingFiles);
    }
  };

  const removePendingFile = (index: number) => {
    setPendingFiles((prev) => prev.filter((_, i) => i !== index));
  };

  return (
    <div style={{ padding: '40px 48px', maxWidth: 900 }}>
      <h1 style={{ margin: 0, fontSize: 24 }}>Recordings</h1>
      <p style={{ color: 'var(--fg-muted)', marginTop: 4, fontSize: 13 }}>
        Upload screen recordings for your project scenes
      </p>

      {/* Existing recordings summary */}
      {hasStoryboard && (
        <div
          style={{
            background: 'var(--bg-elev)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)',
            padding: 20,
            marginTop: 24,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 600 }}>
                {recordedScenes.length} of {scenes.length} scenes recorded
              </div>
              <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 4 }}>
                {recordedScenes.length === scenes.length
                  ? 'All scenes have recordings'
                  : `${scenes.length - recordedScenes.length} scene${scenes.length - recordedScenes.length === 1 ? '' : 's'} still need recordings`}
              </div>
            </div>
            <div
              style={{
                width: 48,
                height: 48,
                borderRadius: '50%',
                background: recordedScenes.length === scenes.length ? 'var(--success-bg)' : 'var(--accent-bg)',
                border: `2px solid ${recordedScenes.length === scenes.length ? 'var(--success)' : 'var(--accent)'}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 14,
                fontWeight: 700,
                color: recordedScenes.length === scenes.length ? 'var(--success)' : 'var(--accent)',
              }}
            >
              {Math.round((recordedScenes.length / scenes.length) * 100)}%
            </div>
          </div>

          {/* Scene recording list */}
          <div style={{ marginTop: 16, display: 'grid', gap: 8 }}>
            {scenes.map((scene) => (
              <div
                key={scene.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '10px 14px',
                  background: 'var(--surface)',
                  borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--border)',
                }}
              >
                <span style={{ fontSize: 16, width: 24, textAlign: 'center' }}>
                  {scene.recording ? '✅' : '⬜'}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {scene.name}
                  </div>
                  {scene.recording?.duration_sec != null && (
                    <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 2 }}>
                      {formatDuration(scene.recording.duration_sec)}
                    </div>
                  )}
                </div>
                {!scene.recording && (
                  <Link
                    to={`/project/${projectId}/scene/${scene.id}`}
                    style={{
                      fontSize: 12,
                      color: 'var(--accent)',
                      textDecoration: 'none',
                      padding: '4px 10px',
                      border: '1px solid var(--accent)',
                      borderRadius: 'var(--radius-sm)',
                    }}
                  >
                    Upload
                  </Link>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Upload area */}
      <div style={{ marginTop: 32 }}>
        <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>
          {hasStoryboard ? 'Upload Recordings' : 'Upload Recordings to Get Started'}
        </div>
        <p style={{ color: 'var(--fg-muted)', fontSize: 13, margin: '0 0 16px' }}>
          {hasStoryboard
            ? 'Drop your MP4 files below. They will be assigned to scenes in order.'
            : 'Upload your existing recordings and VPA will analyze them to auto-generate a storyboard with scenes.'}
        </p>

        <RecordingUpload
          onFilesSelected={handleFilesSelected}
          isUploading={isUploading}
          multiple
        />

        {/* Pending files list */}
        {pendingFiles.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
              {pendingFiles.length} file{pendingFiles.length === 1 ? '' : 's'} selected
            </div>
            <div style={{ display: 'grid', gap: 6 }}>
              {pendingFiles.map((file, i) => (
                <div
                  key={`${file.name}-${i}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '8px 12px',
                    background: 'var(--bg-elev)',
                    borderRadius: 'var(--radius-sm)',
                    border: '1px solid var(--border)',
                    fontSize: 13,
                  }}
                >
                  <span style={{ opacity: 0.6 }}>🎬</span>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {file.name}
                  </span>
                  <span style={{ color: 'var(--fg-muted)', fontSize: 12 }}>
                    {formatBytes(file.size)}
                  </span>
                  <button
                    onClick={() => removePendingFile(i)}
                    disabled={isUploading}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: 'var(--fg-muted)',
                      cursor: 'pointer',
                      padding: '2px 6px',
                      fontSize: 16,
                      lineHeight: 1,
                    }}
                    title="Remove"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>

            <div style={{ display: 'flex', gap: 10, marginTop: 14, alignItems: 'center' }}>
              <button
                onClick={handleUpload}
                disabled={isUploading}
                style={{
                  padding: '10px 24px',
                  borderRadius: 'var(--radius-sm)',
                  border: 'none',
                  background: 'var(--accent)',
                  color: '#fff',
                  cursor: isUploading ? 'wait' : 'pointer',
                  fontSize: 14,
                  fontWeight: 600,
                  opacity: isUploading ? 0.7 : 1,
                }}
              >
                {isUploading
                  ? 'Uploading...'
                  : hasStoryboard
                    ? `Upload to Scenes`
                    : `Upload & Generate Storyboard`}
              </button>
              <button
                onClick={() => setPendingFiles([])}
                disabled={isUploading}
                style={{
                  padding: '10px 18px',
                  borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--border)',
                  background: 'transparent',
                  color: 'var(--fg-muted)',
                  cursor: 'pointer',
                  fontSize: 13,
                }}
              >
                Clear
              </button>
            </div>
          </div>
        )}

        {/* Success feedback */}
        {bulkMutation.isSuccess && (
          <div
            style={{
              marginTop: 16,
              padding: '12px 16px',
              background: 'var(--success-bg)',
              border: '1px solid var(--success)',
              borderRadius: 'var(--radius-sm)',
              fontSize: 13,
              color: 'var(--success)',
            }}
          >
            Successfully uploaded {bulkMutation.data.assignedCount} recording{bulkMutation.data.assignedCount === 1 ? '' : 's'} to {bulkMutation.data.totalScenes} scene{bulkMutation.data.totalScenes === 1 ? '' : 's'}.
          </div>
        )}

        {generateMutation.isSuccess && (
          <div
            style={{
              marginTop: 16,
              padding: '12px 16px',
              background: 'var(--success-bg)',
              border: '1px solid var(--success)',
              borderRadius: 'var(--radius-sm)',
              fontSize: 13,
              color: 'var(--success)',
            }}
          >
            Storyboard generated! Check the{' '}
            <Link to={`/project/${projectId}/storyboard`} style={{ color: 'var(--accent)' }}>
              Storyboard
            </Link>{' '}
            page to review your scenes.
          </div>
        )}

        {errorMsg && (
          <div
            style={{
              marginTop: 16,
              padding: '12px 16px',
              background: 'var(--danger-bg)',
              border: '1px solid var(--danger)',
              borderRadius: 'var(--radius-sm)',
              fontSize: 13,
              color: 'var(--danger)',
            }}
          >
            {errorMsg}
          </div>
        )}
      </div>
    </div>
  );
}
