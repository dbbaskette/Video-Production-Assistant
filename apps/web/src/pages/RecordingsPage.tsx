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
import { CheckCircle2, Circle } from 'lucide-react';
import { storyboardApi, recordingsApi, assetsApi, type UploadProgress } from '../lib/api.js';
import { RecordingUpload } from '../components/RecordingUpload.js';
import { STATUS_COLOR } from '../lib/palette.js';
import type { Asset, ProjectTrackerEntry, Scene } from '@vpa/shared';
import { recordingsDurationLabel } from '../lib/scene-duration.js';

interface WorkspaceContext {
  project: ProjectTrackerEntry;
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
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const [generateBannerVisible, setGenerateBannerVisible] = useState(false);

  // Generate: no storyboard yet — a scene-per-file is created.
  const generateMutation = useMutation({
    mutationFn: (files: File[]) =>
      recordingsApi.generateStoryboard(projectId!, files, { onProgress: setUploadProgress }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['storyboard', projectId] });
      setPendingFiles([]);
      setGenerateBannerVisible(true);
    },
    onSettled: () => setUploadProgress(null),
  });

  // Auto-dismiss success banners.
  useEffect(() => {
    if (!generateBannerVisible) return;
    const t = window.setTimeout(() => setGenerateBannerVisible(false), 8000);
    return () => window.clearTimeout(t);
  }, [generateBannerVisible]);

  const isUploading = generateMutation.isPending;
  const uploadPct = uploadProgress?.fraction != null ? Math.round(uploadProgress.fraction * 100) : null;
  const error = generateMutation.error;
  const errorMsg = error instanceof Error ? error.message : null;

  const handleUploadFresh = () => {
    if (pendingFiles.length > 0) generateMutation.mutate(pendingFiles);
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

      <SourceTray projectId={projectId!} scenes={scenes} />

      {/* ── PHASE: fresh — no storyboard yet ──────────────────────── */}
      {phase === 'fresh' && (
        <div style={{ marginTop: 32 }}>
          <RecordingUpload
            onFilesSelected={(files) => setPendingFiles(files)}
            isUploading={isUploading}
            progress={uploadProgress}
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
                  ? `Uploading…${uploadPct != null ? ` ${uploadPct}%` : ''}`
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
        <SceneList scenes={scenes} projectId={projectId!} />
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
              To replace one or many recordings, import them in the source tray and review each scene pairing before assigning.
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

function SourceTray({ projectId, scenes }: { projectId: string; scenes: Scene[] }) {
  const queryClient = useQueryClient();
  const [files, setFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState(false);

  const assetsQuery = useQuery({
    queryKey: ['assets', projectId],
    queryFn: () => assetsApi.list(projectId),
  });
  const revisionQuery = useQuery({
    queryKey: ['revision', projectId],
    queryFn: () => assetsApi.currentRevision(projectId),
  });
  useEffect(() => {
    if (assetsQuery.data) queryClient.invalidateQueries({ queryKey: ['revision', projectId] });
  }, [assetsQuery.data, projectId, queryClient]);
  const importMutation = useMutation({
    mutationFn: () => assetsApi.import(projectId, files, { onProgress: setProgress }),
    onSuccess: (imported) => {
      setFiles([]);
      setMapping((current) => {
        const next = { ...current };
        imported.forEach((asset, index) => {
          const scene = scenes[index];
          if (scene) next[asset.id] = scene.id;
        });
        return next;
      });
      queryClient.invalidateQueries({ queryKey: ['assets', projectId] });
    },
    onSettled: () => setProgress(null),
  });
  const assignMutation = useMutation({
    mutationFn: async () => {
      const selected = Object.entries(mapping).filter((entry): entry is [string, string] => Boolean(entry[1]));
      if (revisionQuery.data == null || selected.length === 0) throw new Error('Choose at least one scene.');
      return assetsApi.assign(
        projectId,
        revisionQuery.data,
        selected.map(([assetId, sceneId]) => {
          const asset = assets.find((candidate) => candidate.id === assetId)!;
          const role = asset.media_kind === 'video' ? 'screen' : asset.media_kind === 'audio' ? 'microphone' : 'image';
          return { assetId, sceneId, role, timingOriginMs: 0 };
        }),
      );
    },
    onSuccess: () => {
      setMapping({});
      queryClient.invalidateQueries({ queryKey: ['storyboard', projectId] });
      queryClient.invalidateQueries({ queryKey: ['revision', projectId] });
    },
  });
  const retryMutation = useMutation({
    mutationFn: (assetId: string) => assetsApi.retry(projectId, assetId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['assets', projectId] }),
  });
  const assets = assetsQuery.data ?? [];
  const selectedCount = Object.values(mapping).filter(Boolean).length;
  const replacementCount = Object.entries(mapping).filter(([assetId, sceneId]) => {
    if (!sceneId) return false;
    const scene = scenes.find((candidate) => candidate.id === sceneId);
    return Boolean(scene?.recording && scene.recording.asset_id !== assetId);
  }).length;
  const operationError = importMutation.error ?? assignMutation.error;

  return (
    <section style={{ marginTop: 24, border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', background: 'var(--bg-elev)' }}>
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 16px', border: 0, background: 'transparent', color: 'var(--fg)', cursor: 'pointer', textAlign: 'left' }}
      >
        <span>
          <strong>Source tray</strong>
          <span style={{ display: 'block', color: 'var(--fg-muted)', fontSize: 12, marginTop: 3 }}>
            Import once, preview sources, then choose exactly which scene receives each file.
          </span>
        </span>
        <span style={{ color: 'var(--fg-muted)', fontSize: 12 }}>{assets.length} source{assets.length === 1 ? '' : 's'} {expanded ? '▲' : '▼'}</span>
      </button>
      {expanded && (
        <div style={{ borderTop: '1px solid var(--border)', padding: 16 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontSize: 13 }}>
              Choose media
              <input
                type="file"
                multiple
                accept="video/mp4,video/webm,image/png,image/jpeg,audio/mpeg,audio/wav"
                style={{ display: 'none' }}
                onChange={(event) => setFiles(Array.from(event.target.files ?? []))}
              />
            </label>
            {files.length > 0 && (
              <button className="primary" disabled={importMutation.isPending} onClick={() => importMutation.mutate()}>
                {importMutation.isPending
                  ? `Importing${progress?.fraction != null ? ` ${Math.round(progress.fraction * 100)}%` : '…'}`
                  : `Import ${files.length} source${files.length === 1 ? '' : 's'}`}
              </button>
            )}
            <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>MP4, WebM, PNG, JPEG, MP3, WAV · 2 GiB max · video 20 min max</span>
          </div>

          {assets.length > 0 && (
            <div style={{ display: 'grid', gap: 10, marginTop: 16 }}>
              {assets.map((asset) => (
                <SourceRow
                  key={asset.id}
                  asset={asset}
                  projectId={projectId}
                  scenes={scenes}
                  sceneId={mapping[asset.id] ?? ''}
                  onScene={(sceneId) => setMapping((current) => ({ ...current, [asset.id]: sceneId }))}
                  onRetry={() => retryMutation.mutate(asset.id)}
                />
              ))}
            </div>
          )}

          {selectedCount > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14 }}>
              <button className="primary" disabled={assignMutation.isPending || revisionQuery.data == null} onClick={() => assignMutation.mutate()}>
                {assignMutation.isPending
                  ? 'Assigning…'
                  : `Assign ${selectedCount} source${selectedCount === 1 ? '' : 's'}${replacementCount > 0 ? ` · replace ${replacementCount} recording${replacementCount === 1 ? '' : 's'}` : ''}`}
              </button>
              <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>Review every pairing before you commit.</span>
            </div>
          )}
          {operationError && (
            <p style={{ color: 'var(--danger)', fontSize: 12, marginBottom: 0 }}>
              {operationError instanceof Error
                ? operationError.message
                : 'The source operation failed.'}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function SourceRow({
  asset,
  projectId,
  scenes,
  sceneId,
  onScene,
  onRetry,
}: {
  asset: Asset;
  projectId: string;
  scenes: Scene[];
  sceneId: string;
  onScene: (sceneId: string) => void;
  onRetry: () => void;
}) {
  const url = assetsApi.contentUrl(projectId, asset.id);
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '88px minmax(0, 1fr) minmax(180px, 260px)', gap: 12, alignItems: 'center', padding: 10, border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', background: 'var(--surface)' }}>
      <div style={{ width: 88, height: 50, borderRadius: 6, overflow: 'hidden', background: 'var(--bg)', display: 'grid', placeItems: 'center' }}>
        {asset.media_kind === 'image' ? <img src={url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : null}
        {asset.media_kind === 'video' ? <video src={url} muted preload="metadata" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : null}
        {asset.media_kind === 'audio' ? <span style={{ fontSize: 20 }}>♪</span> : null}
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{asset.original_name}</div>
        <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginTop: 3 }}>{asset.media_kind} · {asset.origin} · {formatBytes(asset.size_bytes)} · {asset.preparation.status}</div>
        {asset.preparation.status === 'failed' && (
          <button type="button" onClick={onRetry} style={{ marginTop: 5, border: 0, padding: 0, background: 'transparent', color: 'var(--accent)', cursor: 'pointer', fontSize: 11 }}>
            Retry preview preparation
          </button>
        )}
      </div>
      <select value={sceneId} onChange={(event) => onScene(event.target.value)} style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', background: 'var(--bg)', color: 'var(--fg)' }}>
        <option value="">Do not assign</option>
        {scenes.map((scene) => (
          <option key={scene.id} value={scene.id}>
            {scene.name}{scene.recording ? ' (replaces current recording)' : ''}
          </option>
        ))}
      </select>
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
              {recordingsDurationLabel(scene) != null && (
                <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 2 }}>
                  {recordingsDurationLabel(scene)}
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
                to={`/project/${projectId}/scene/${scene.id}?tab=Recording`}
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
