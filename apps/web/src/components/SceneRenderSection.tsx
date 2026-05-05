/**
 * Per-scene render section — sits at the bottom of the Preview tab. Lets
 * the user produce three grab-and-go files for one scene:
 *   • combined.mp4   video + LT + narration (the all-in-one)
 *   • overlay.mp4    video + LT only (or raw recording if no LTs)
 *   • narration.mp3  joined narration audio
 *
 * Independent of the project-level render. Useful when the user wants to
 * drop one scene into another editor (Premiere / Resolve / etc.) instead
 * of going through the full final-cut concat.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { sceneRenderApi, type SceneRenderKind } from '../lib/api.js';
import { GenerationModal } from './ui/GenerationModal.js';
import { STATUS_COLOR } from '../lib/palette.js';

interface Props {
  projectId: string;
  sceneId: string;
}

export function SceneRenderSection({ projectId, sceneId }: Props) {
  const qc = useQueryClient();
  const [audioMode, setAudioMode] = useState<'replace' | 'mix'>('replace');

  const status = useQuery({
    queryKey: ['scene-render-status', projectId, sceneId],
    queryFn: () => sceneRenderApi.status(projectId, sceneId),
  });

  const renderMutation = useMutation({
    mutationFn: () => sceneRenderApi.start(projectId, sceneId, { audioMode }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['scene-render-status', projectId, sceneId] });
    },
  });

  const files = status.data?.files;
  const anyExists = !!files && (files.combined.exists || files.overlay.exists || files.narration.exists);

  return (
    <div
      style={{
        marginTop: 24,
        background: 'var(--bg-elev)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: 20,
      }}
    >
      <GenerationModal
        open={renderMutation.isPending}
        title="Rendering scene"
        phase="Burning lower thirds, joining narration, muxing combined video…"
        hint="ffmpeg runs three passes: overlay → narration → combined. Usually 10–30 seconds per scene minute."
      />

      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 12, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: 1 }}>
            Per-scene Export
          </div>
          <div style={{ fontSize: 16, fontWeight: 600, marginTop: 4 }}>
            {anyExists ? 'Scene render available' : 'Scene not rendered yet'}
          </div>
          <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 4 }}>
            Produces three files in <code>renders/scenes/{sceneId.slice(0, 8)}…/</code>: the combined cut, the
            video-with-lower-thirds, and the narration audio — each downloadable below.
          </div>
        </div>
      </div>

      {/* Options */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 12, fontSize: 13 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          Audio:
          <select
            value={audioMode}
            onChange={(e) => setAudioMode(e.target.value as 'replace' | 'mix')}
            disabled={renderMutation.isPending}
            style={{
              padding: '4px 8px',
              background: 'var(--bg)',
              color: 'var(--fg)',
              border: '1px solid var(--border)',
              borderRadius: 4,
            }}
          >
            <option value="replace">replace original (narration only)</option>
            <option value="mix">mix narration over original (-20dB)</option>
          </select>
        </label>
      </div>

      <button
        onClick={() => renderMutation.mutate()}
        disabled={renderMutation.isPending}
        className="primary"
        style={{
          padding: '8px 18px',
          fontSize: 13,
          fontWeight: 600,
          marginBottom: 12,
        }}
      >
        {renderMutation.isPending
          ? 'Rendering…'
          : anyExists
            ? 'Re-render scene'
            : 'Render scene'}
      </button>

      {renderMutation.isError && (
        <p style={{ color: 'var(--danger)', fontSize: 13, marginBottom: 12 }}>
          Render failed:{' '}
          {renderMutation.error instanceof Error ? renderMutation.error.message : 'Unknown error'}
        </p>
      )}

      {renderMutation.isSuccess && (
        <p style={{ color: STATUS_COLOR.success, fontSize: 12, marginBottom: 12 }}>
          Rendered ({renderMutation.data.durationSec.toFixed(1)}s)
          {!renderMutation.data.hadLowerThirds && ' — no lower thirds, overlay.mp4 is a copy of the recording'}
          {!renderMutation.data.hasNarration && ' — no narration audio'}
        </p>
      )}

      {/* Per-file download links */}
      {files && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
          <FileRow
            kind="combined"
            label="Combined (video + LT + narration)"
            file={files.combined}
            projectId={projectId}
            sceneId={sceneId}
          />
          <FileRow
            kind="overlay"
            label="Overlay only (video + LT)"
            file={files.overlay}
            projectId={projectId}
            sceneId={sceneId}
          />
          <FileRow
            kind="narration"
            label="Narration audio (mp3)"
            file={files.narration}
            projectId={projectId}
            sceneId={sceneId}
          />
        </div>
      )}
    </div>
  );
}

function FileRow({
  kind,
  label,
  file,
  projectId,
  sceneId,
}: {
  kind: SceneRenderKind;
  label: string;
  file: { exists: boolean; sizeBytes?: number; modifiedAt?: string };
  projectId: string;
  sceneId: string;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        padding: '8px 12px',
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        fontSize: 13,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
        <span
          aria-hidden
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: file.exists ? STATUS_COLOR.success : 'var(--border)',
            flexShrink: 0,
          }}
        />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {label}
        </span>
        {file.exists && file.sizeBytes !== undefined && (
          <span style={{ color: 'var(--fg-muted)', fontSize: 11, flexShrink: 0 }}>
            · {formatSize(file.sizeBytes)}
          </span>
        )}
      </div>
      {file.exists ? (
        <a
          href={sceneRenderApi.fileUrl(projectId, sceneId, kind)}
          download
          style={{ color: 'var(--accent)', fontSize: 12, flexShrink: 0 }}
        >
          Download
        </a>
      ) : (
        <span style={{ color: 'var(--fg-muted)', fontSize: 11, flexShrink: 0 }}>not rendered</span>
      )}
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
