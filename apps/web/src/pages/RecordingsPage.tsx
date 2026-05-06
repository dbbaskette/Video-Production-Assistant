/**
 * Recordings page — single-purpose primary affordance per state:
 *
 *   • No storyboard yet ("fresh"):
 *     Big drop zone is THE thing on screen. We treat the upload as the
 *     "create a scene per file" action; bulk-from-recordings is the
 *     entire pitch when this page is reached from the "I have recordings"
 *     dashboard hero.
 *
 *   • Storyboard exists, some scenes missing recordings ("in progress"):
 *     Lead with the scene list. Each row whose scene is missing a
 *     recording gets a prominent + Upload action. Bulk-by-order is
 *     demoted to a secondary "Upload many at once" panel that has to be
 *     expanded on demand — nothing surfaces it by default because mixing
 *     the two affordances is what made this page confusing.
 *
 *   • All scenes recorded ("complete"):
 *     The page collapses to a "✓ All scenes recorded — upload again to
 *     replace" link. No upload UX visible by default.
 */

import { useEffect, useState } from 'react';
import { useParams, useOutletContext, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Circle, ChevronDown, ChevronRight } from 'lucide-react';
import { storyboardApi, recordingsApi } from '../lib/api.js';
import { RecordingUpload } from '../components/RecordingUpload.js';
import { STATUS_COLOR } from '../lib/palette.js';
import type { ProjectTrackerEntry, Scene } from '@vpa/shared';

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

type Phase = 'fresh' | 'in-progress' | 'complete';

export function RecordingsPage() {
  const { project } = useOutletContext<WorkspaceContext>();
  const { projectId } = useParams<{ projectId: string }>();
  const queryClient = useQueryClient();
  void project; // referenced for outlet typing

  const { data: storyboard } = useQuery({
    queryKey: ['storyboard', projectId],
    queryFn: () => storyboardApi.get(projectId!),
    enabled: !!projectId,
  });

  const scenes: Scene[] = storyboard?.scenes ?? [];
  const hasStoryboard = storyboard != null && scenes.length > 0;
  const recordedScenes = scenes.filter((s) => s.recording);
  const phase: Phase = !hasStoryboard
    ? 'fresh'
    : recordedScenes.length === scenes.length
      ? 'complete'
      : 'in-progress';

  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [bulkBannerVisible, setBulkBannerVisible] = useState(false);
  const [generateBannerVisible, setGenerateBannerVisible] = useState(false);
  // In-progress phase hides bulk-upload by default; this expands it on demand.
  const [bulkExpanded, setBulkExpanded] = useState(false);
  // Complete phase hides upload UI by default; this brings it back.
  const [completeUploadAgain, setCompleteUploadAgain] = useState(false);

  // Bulk: assign uploaded recordings to existing scenes by file order.
  const bulkMutation = useMutation({
    mutationFn: (files: File[]) => recordingsApi.uploadBulk(projectId!, files),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['storyboard', projectId] });
      setPendingFiles([]);
      setBulkExpanded(false);
      setCompleteUploadAgain(false);
      setBulkBannerVisible(true);
    },
  });

  // Generate: no storyboard yet — a scene-per-file is created.
  const generateMutation = useMutation({
    mutationFn: (files: File[]) => recordingsApi.generateStoryboard(projectId!, files),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['storyboard', projectId] });
      setPendingFiles([]);
      setGenerateBannerVisible(true);
    },
  });

  // Auto-dismiss success banners.
  useEffect(() => {
    if (!bulkBannerVisible) return;
    const t = window.setTimeout(() => setBulkBannerVisible(false), 6000);
    return () => window.clearTimeout(t);
  }, [bulkBannerVisible]);
  useEffect(() => {
    if (!generateBannerVisible) return;
    const t = window.setTimeout(() => setGenerateBannerVisible(false), 8000);
    return () => window.clearTimeout(t);
  }, [generateBannerVisible]);

  const isUploading = bulkMutation.isPending || generateMutation.isPending;
  const error = bulkMutation.error || generateMutation.error;
  const errorMsg = error instanceof Error ? error.message : null;

  const handleUploadFresh = () => {
    if (pendingFiles.length > 0) generateMutation.mutate(pendingFiles);
  };
  const handleUploadBulk = () => {
    if (pendingFiles.length > 0) bulkMutation.mutate(pendingFiles);
  };
  const removePendingFile = (index: number) => {
    setPendingFiles((prev) => prev.filter((_, i) => i !== index));
  };

  return (
    <div style={{ padding: '40px 48px', maxWidth: 900 }}>
      <h1 style={{ margin: 0, fontSize: 24 }}>Recordings</h1>
      <p style={{ color: 'var(--fg-muted)', marginTop: 4, fontSize: 13 }}>
        {phase === 'fresh'
          ? 'Drop one MP4 per scene. We\'ll analyze each and build the storyboard for you.'
          : phase === 'complete'
            ? 'All scenes have recordings.'
            : `${recordedScenes.length} of ${scenes.length} scenes recorded — fill in the rest below.`}
      </p>

      {/* ── PHASE: fresh — no storyboard yet ──────────────────────── */}
      {phase === 'fresh' && (
        <div style={{ marginTop: 32 }}>
          <RecordingUpload
            onFilesSelected={(files) => setPendingFiles(files)}
            isUploading={isUploading}
            multiple
          />
          <PendingFiles
            files={pendingFiles}
            onRemove={removePendingFile}
            disabled={isUploading}
          />
          {pendingFiles.length > 0 && (
            <div style={{ display: 'flex', gap: 10, marginTop: 14, alignItems: 'center' }}>
              <button
                onClick={handleUploadFresh}
                disabled={isUploading}
                className="primary"
                style={{ padding: '10px 24px', fontSize: 14, fontWeight: 600 }}
              >
                {isUploading
                  ? 'Uploading…'
                  : `Upload ${pendingFiles.length} recording${pendingFiles.length === 1 ? '' : 's'} & build storyboard`}
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
          )}
        </div>
      )}

      {/* ── PHASE: in-progress — fill in missing scenes ───────────── */}
      {phase === 'in-progress' && (
        <>
          <SceneList scenes={scenes} projectId={projectId!} />

          {/* Bulk upload — secondary, collapsed by default. The whole point
              of demoting it is to stop competing with per-scene Upload
              affordances. Users who want to drop 5 files at once can
              still do that, just one click away. */}
          <div
            style={{
              marginTop: 24,
              border: '1px solid var(--border)',
              borderRadius: 8,
              background: 'var(--bg-elev)',
            }}
          >
            <button
              onClick={() => setBulkExpanded((v) => !v)}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                width: '100%',
                padding: '12px 16px',
                background: 'transparent',
                border: 'none',
                borderRadius: 8,
                color: 'var(--fg)',
                cursor: 'pointer',
                fontSize: 13,
                fontWeight: 500,
                textAlign: 'left',
              }}
              aria-expanded={bulkExpanded}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                {bulkExpanded ? (
                  <ChevronDown size={14} strokeWidth={2} color="var(--fg-muted)" aria-hidden />
                ) : (
                  <ChevronRight size={14} strokeWidth={2} color="var(--fg-muted)" aria-hidden />
                )}
                Upload many at once (assigns to scenes by file order)
              </span>
              <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>secondary</span>
            </button>
            {bulkExpanded && (
              <div style={{ padding: '0 16px 16px' }}>
                <p style={{ fontSize: 12, color: 'var(--fg-muted)', margin: '0 0 12px' }}>
                  Files attach to scenes in storyboard order. Drop {scenes.length} MP4s and the
                  Nth file becomes the recording for the Nth scene.
                </p>
                <RecordingUpload
                  onFilesSelected={(files) => setPendingFiles(files)}
                  isUploading={isUploading}
                  multiple
                />
                <PendingFiles
                  files={pendingFiles}
                  onRemove={removePendingFile}
                  disabled={isUploading}
                />
                {pendingFiles.length > 0 && (
                  <div style={{ display: 'flex', gap: 10, marginTop: 14, alignItems: 'center' }}>
                    <button
                      onClick={handleUploadBulk}
                      disabled={isUploading}
                      className="primary"
                      style={{ padding: '8px 18px', fontSize: 13, fontWeight: 600 }}
                    >
                      {isUploading
                        ? 'Uploading…'
                        : `Upload to ${Math.min(pendingFiles.length, scenes.length)} scene${Math.min(pendingFiles.length, scenes.length) === 1 ? '' : 's'}`}
                    </button>
                    <button
                      onClick={() => setPendingFiles([])}
                      disabled={isUploading}
                      style={{
                        padding: '8px 14px',
                        borderRadius: 'var(--radius-sm)',
                        border: '1px solid var(--border)',
                        background: 'transparent',
                        color: 'var(--fg-muted)',
                        cursor: 'pointer',
                        fontSize: 12,
                      }}
                    >
                      Clear
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      )}

      {/* ── PHASE: complete — collapsed UX, link to upload again ──── */}
      {phase === 'complete' && (
        <div
          style={{
            marginTop: 32,
            padding: 20,
            background: 'var(--bg-elev)',
            border: `1px solid ${STATUS_COLOR.success}`,
            borderRadius: 8,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 16,
          }}
        >
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: STATUS_COLOR.success }}>
              ✓ All {scenes.length} scenes have recordings
            </div>
            <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 4 }}>
              Need to swap a recording? Open the scene from the storyboard, or{' '}
              <button
                onClick={() => setCompleteUploadAgain((v) => !v)}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--accent)',
                  cursor: 'pointer',
                  padding: 0,
                  fontSize: 12,
                  textDecoration: 'underline',
                }}
              >
                {completeUploadAgain ? 'hide upload form' : 'upload all again'}
              </button>
              .
            </div>
          </div>
          <Link
            to={`/project/${projectId}/storyboard`}
            style={{
              fontSize: 12,
              color: 'var(--accent)',
              textDecoration: 'none',
              padding: '6px 14px',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
              flexShrink: 0,
            }}
          >
            Open Storyboard →
          </Link>
        </div>
      )}

      {phase === 'complete' && completeUploadAgain && (
        <div style={{ marginTop: 16 }}>
          <p style={{ fontSize: 12, color: 'var(--fg-muted)', margin: '0 0 12px' }}>
            Replaces every scene's recording with the file at the matching index. Drop {scenes.length} MP4s.
          </p>
          <RecordingUpload
            onFilesSelected={(files) => setPendingFiles(files)}
            isUploading={isUploading}
            multiple
          />
          <PendingFiles
            files={pendingFiles}
            onRemove={removePendingFile}
            disabled={isUploading}
          />
          {pendingFiles.length > 0 && (
            <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
              <button
                onClick={handleUploadBulk}
                disabled={isUploading}
                className="primary"
                style={{ padding: '8px 18px', fontSize: 13, fontWeight: 600 }}
              >
                {isUploading ? 'Uploading…' : 'Replace recordings'}
              </button>
              <button
                onClick={() => setPendingFiles([])}
                disabled={isUploading}
                style={{
                  padding: '8px 14px',
                  borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--border)',
                  background: 'transparent',
                  color: 'var(--fg-muted)',
                  cursor: 'pointer',
                  fontSize: 12,
                }}
              >
                Clear
              </button>
            </div>
          )}
        </div>
      )}

      {/* Success banners (shared across phases) */}
      {bulkBannerVisible && bulkMutation.isSuccess && bulkMutation.data && (
        <div
          style={{
            marginTop: 16,
            padding: '12px 16px',
            background: 'var(--success-bg)',
            border: '1px solid var(--success)',
            borderRadius: 'var(--radius-sm)',
            fontSize: 13,
            color: 'var(--success)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <span>
            Successfully uploaded {bulkMutation.data.assignedCount} recording
            {bulkMutation.data.assignedCount === 1 ? '' : 's'} to {bulkMutation.data.totalScenes} scene
            {bulkMutation.data.totalScenes === 1 ? '' : 's'}.
          </span>
          <button
            onClick={() => setBulkBannerVisible(false)}
            aria-label="Dismiss"
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--success)',
              cursor: 'pointer',
              padding: 4,
              lineHeight: 1,
            }}
          >
            ✕
          </button>
        </div>
      )}

      {generateBannerVisible && generateMutation.isSuccess && (
        <div
          style={{
            marginTop: 16,
            padding: '12px 16px',
            background: 'var(--success-bg)',
            border: '1px solid var(--success)',
            borderRadius: 'var(--radius-sm)',
            fontSize: 13,
            color: 'var(--success)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <span>
            Storyboard generated! Check the{' '}
            <Link to={`/project/${projectId}/storyboard`} style={{ color: 'var(--accent)' }}>
              Storyboard
            </Link>{' '}
            page to review your scenes.
          </span>
          <button
            onClick={() => setGenerateBannerVisible(false)}
            aria-label="Dismiss"
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--success)',
              cursor: 'pointer',
              padding: 4,
              lineHeight: 1,
            }}
          >
            ✕
          </button>
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
  );
}

// ── Subcomponents ─────────────────────────────────────────────────

function SceneList({ scenes, projectId }: { scenes: Scene[]; projectId: string }) {
  return (
    <div
      style={{
        marginTop: 24,
        background: 'var(--bg-elev)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)',
        padding: 20,
      }}
    >
      <div style={{ fontSize: 12, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 12 }}>
        Scenes
      </div>
      <div style={{ display: 'grid', gap: 8 }}>
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
            <span
              style={{
                width: 24,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: scene.recording ? STATUS_COLOR.success : 'var(--fg-dim)',
              }}
            >
              {scene.recording ? (
                <CheckCircle2 size={18} strokeWidth={1.8} aria-hidden />
              ) : (
                <Circle size={18} strokeWidth={1.5} aria-hidden />
              )}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: 14,
                  fontWeight: 500,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {scene.name}
              </div>
              {scene.recording?.duration_sec != null && (
                <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 2 }}>
                  {formatDuration(scene.recording.duration_sec)}
                </div>
              )}
            </div>
            {scene.recording ? (
              <Link
                to={`/project/${projectId}/storyboard?scene=${scene.id}`}
                style={{
                  fontSize: 12,
                  color: 'var(--fg-muted)',
                  textDecoration: 'none',
                  padding: '4px 10px',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-sm)',
                }}
              >
                Open
              </Link>
            ) : (
              <Link
                to={`/project/${projectId}/scene/${scene.id}`}
                className="primary"
                style={{
                  fontSize: 12,
                  textDecoration: 'none',
                  padding: '6px 14px',
                  borderRadius: 'var(--radius-sm)',
                  fontWeight: 600,
                }}
              >
                + Upload
              </Link>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function PendingFiles({
  files,
  onRemove,
  disabled,
}: {
  files: File[];
  onRemove: (i: number) => void;
  disabled: boolean;
}) {
  if (files.length === 0) return null;
  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
        {files.length} file{files.length === 1 ? '' : 's'} selected
      </div>
      <div style={{ display: 'grid', gap: 6 }}>
        {files.map((file, i) => (
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
              onClick={() => onRemove(i)}
              disabled={disabled}
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
    </div>
  );
}
