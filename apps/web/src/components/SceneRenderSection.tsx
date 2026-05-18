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
import { sceneRenderApi, storyboardApi, framesApi, type SceneRenderKind } from '../lib/api.js';
import { GenerationModal } from './ui/GenerationModal.js';
import { FrameStylePicker } from './FrameStylePicker.js';
import { STATUS_COLOR } from '../lib/palette.js';
import { Clapperboard } from 'lucide-react';

interface Props {
  projectId: string;
  sceneId: string;
}

export function SceneRenderSection({ projectId, sceneId }: Props) {
  const qc = useQueryClient();
  const [audioMode, setAudioMode] = useState<'replace' | 'mix'>('replace');
  // Controls whether the user has expanded the per-scene frame override editor.
  const [frameOverrideOpen, setFrameOverrideOpen] = useState(false);

  const status = useQuery({
    queryKey: ['scene-render-status', projectId, sceneId],
    queryFn: () => sceneRenderApi.status(projectId, sceneId),
  });

  // Frames manifest — already cached if ProjectOverview mounted.
  const framesQuery = useQuery({
    queryKey: ['frames'],
    queryFn: () => framesApi.list(),
  });

  // Storyboard — already cached by ProjectOverview; reuse the same query key.
  const storyboardQuery = useQuery({
    queryKey: ['storyboard', projectId],
    queryFn: () => storyboardApi.get(projectId),
    enabled: !!projectId,
  });

  // Resolve this scene's frame settings.
  const scene = storyboardQuery.data?.scenes.find((s) => s.id === sceneId);
  const hasOverride =
    scene?.frame_style !== undefined || scene?.frame_background !== undefined;

  const setSceneFrameMutation = useMutation({
    mutationFn: (next: { frame_style?: string | null; frame_background?: 'brand' | 'transparent' | string | null }) =>
      storyboardApi.setSceneFrame(projectId, sceneId, next),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['storyboard', projectId] });
      qc.invalidateQueries({ queryKey: ['scene-render-status', projectId, sceneId] });
    },
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

      {/* Frame style — per-scene override, falls back to project default */}
      {framesQuery.data && framesQuery.data.length > 0 && (
        <div
          style={{
            marginBottom: 16,
            paddingTop: 14,
            borderTop: '1px dashed var(--border)',
            fontSize: 13,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
            <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.6, color: 'var(--fg-muted)' }}>
              Frame style
            </div>
            {hasOverride && (
              <button
                type="button"
                onClick={() =>
                  setSceneFrameMutation.mutate({ frame_style: null, frame_background: null })
                }
                disabled={setSceneFrameMutation.isPending}
                style={{
                  fontSize: 11,
                  color: 'var(--fg-muted)',
                  background: 'transparent',
                  border: 'none',
                  padding: 0,
                  cursor: 'pointer',
                  textDecoration: 'underline',
                }}
              >
                Reset to project default
              </button>
            )}
          </div>

          {!hasOverride && !frameOverrideOpen ? (
            /* Show what the project default is, with an Override affordance */
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ color: 'var(--fg-muted)', fontSize: 12 }}>
                {(() => {
                  const defStyle = storyboardQuery.data?.defaults?.frame_style;
                  if (!defStyle) return 'Uses project default: None';
                  const frame = framesQuery.data?.find((f) => f.id === defStyle);
                  return frame
                    ? `Uses project default: ${frame.family} — ${frame.variant}`
                    : `Uses project default: ${defStyle}`;
                })()}
              </span>
              <button
                type="button"
                onClick={() => setFrameOverrideOpen(true)}
                style={{
                  fontSize: 11,
                  color: 'var(--accent)',
                  background: 'transparent',
                  border: 'none',
                  padding: 0,
                  cursor: 'pointer',
                  textDecoration: 'underline',
                }}
              >
                Override
              </button>
            </div>
          ) : (
            /* Override editor — either user clicked Override or a per-scene value already exists */
            <>
              <FrameStylePicker
                frames={framesQuery.data}
                value={{
                  frameStyle: scene?.frame_style ?? null,
                  frameBackground: scene?.frame_background ?? null,
                }}
                onChange={(next) =>
                  setSceneFrameMutation.mutate({
                    frame_style: next.frameStyle,
                    frame_background: next.frameBackground,
                  })
                }
              />
              {!hasOverride && (
                <button
                  type="button"
                  onClick={() => setFrameOverrideOpen(false)}
                  style={{
                    fontSize: 11,
                    color: 'var(--fg-muted)',
                    background: 'transparent',
                    border: 'none',
                    padding: '6px 0 0',
                    cursor: 'pointer',
                    textDecoration: 'underline',
                    display: 'block',
                  }}
                >
                  Cancel override
                </button>
              )}
              {setSceneFrameMutation.isPending && (
                <p style={{ fontSize: 11, color: 'var(--fg-muted)', marginTop: 6, marginBottom: 0 }}>Saving…</p>
              )}
              {setSceneFrameMutation.isError && (
                <p style={{ fontSize: 11, color: 'var(--danger)', marginTop: 6, marginBottom: 0 }}>
                  {setSceneFrameMutation.error instanceof Error
                    ? setSceneFrameMutation.error.message
                    : 'Save failed'}
                </p>
              )}
            </>
          )}
        </div>
      )}
      {framesQuery.isError && (
        <p style={{ fontSize: 11, color: 'var(--danger)', marginBottom: 12 }}>
          Could not load frame templates.
        </p>
      )}

      {/* Visual distinction from the project-level "Render Finished Video"
          button: this one is a secondary outlined button labelled "Render
          this scene" so the user can tell at a glance they're acting on a
          single scene, not the whole project. */}
      <button
        onClick={() => renderMutation.mutate()}
        disabled={renderMutation.isPending}
        style={{
          padding: '7px 16px',
          fontSize: 13,
          fontWeight: 500,
          marginBottom: 12,
          background: 'var(--surface)',
          color: 'var(--fg)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          cursor: renderMutation.isPending ? 'wait' : 'pointer',
        }}
      >
        {renderMutation.isPending ? (
          'Rendering this scene…'
        ) : (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Clapperboard size={14} strokeWidth={1.8} aria-hidden />
            {anyExists ? 'Re-render this scene' : 'Render this scene'}
          </span>
        )}
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
