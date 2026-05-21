/**
 * Narration page — project-wide list of every scene + its narration status.
 *
 * Replaces the previous sidebar dead-end where clicking "Narration" routed to
 * /storyboard (same as the Storyboard entry). Narration is a per-scene
 * operation, so this page surfaces the cross-scene "where am I?" view:
 *
 *   • Per-row status icon (audio rendered / script only / empty).
 *   • Counts up top (e.g. "3 of 7 narrated · 4 with scripts only").
 *   • Each row deep-links to the scene's Narration tab where the actual
 *     editing happens.
 *   • Narration is OPTIONAL — empty state explicitly says so and points the
 *     user at Render (where they can opt out and ship a silent video).
 */

import { useParams, useOutletContext, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Circle, FileText, Volume2 } from 'lucide-react';
import { storyboardApi } from '../lib/api.js';
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

// Sum chunk durations when the legacy single-track audio isn't present. The
// chunk pattern is the modern path; the `narration.audio` field is the older
// concat-into-one-file style. We support both for backwards compat.
function totalNarrationDuration(scene: Scene): number {
  const n = scene.narration;
  if (!n) return 0;
  const chunks = n.chunks ?? [];
  if (chunks.length > 0) {
    return chunks.reduce((acc, c) => acc + (c.durationSec ?? 0), 0);
  }
  return 0;
}

type Status = 'empty' | 'script-only' | 'narrated';

function statusOf(scene: Scene): Status {
  const n = scene.narration;
  if (!n) return 'empty';
  const hasAudio = !!n.audio || (n.chunks?.some((c) => !!c.audio) ?? false);
  if (hasAudio) return 'narrated';
  const hasScript = !!(n.script || n.monologueScript || n.dialogScript);
  if (hasScript) return 'script-only';
  return 'empty';
}

export function NarrationPage() {
  const { project } = useOutletContext<WorkspaceContext>();
  const { projectId } = useParams<{ projectId: string }>();
  void project;

  const { data: storyboard } = useQuery({
    queryKey: ['storyboard', projectId],
    queryFn: () => storyboardApi.get(projectId!),
    enabled: !!projectId,
  });

  const scenes: Scene[] = storyboard?.scenes ?? [];
  const hasStoryboard = storyboard != null && scenes.length > 0;

  const narratedCount = scenes.filter((s) => statusOf(s) === 'narrated').length;
  const scriptOnlyCount = scenes.filter((s) => statusOf(s) === 'script-only').length;

  return (
    <div style={{ padding: '40px 48px', maxWidth: 900 }}>
      <h1 style={{ margin: 0, fontSize: 24 }}>Narration</h1>
      <p style={{ color: 'var(--fg-muted)', marginTop: 4, fontSize: 13 }}>
        {!hasStoryboard
          ? 'Build a storyboard first — narration applies to each scene.'
          : narratedCount === 0 && scriptOnlyCount === 0
            ? 'Narration is optional. Add it scene-by-scene below, or render without it.'
            : `${narratedCount} of ${scenes.length} scenes narrated${
                scriptOnlyCount > 0 ? ` · ${scriptOnlyCount} with script awaiting audio` : ''
              }.`}
      </p>

      {hasStoryboard && (
        <div style={{ marginTop: 24 }}>
          <SceneList scenes={scenes} projectId={projectId!} />

          {narratedCount === 0 && scriptOnlyCount === 0 && (
            <p
              style={{
                marginTop: 16,
                fontSize: 12,
                color: 'var(--fg-muted)',
                lineHeight: 1.6,
              }}
            >
              Don't need narration? You can{' '}
              <Link to={`/project/${projectId}#render`} style={{ color: 'var(--accent)' }}>
                render
              </Link>{' '}
              without it — the final video will be silent.
            </p>
          )}
        </div>
      )}

      {!hasStoryboard && (
        <div
          style={{
            marginTop: 32,
            padding: 20,
            background: 'var(--bg-elev)',
            border: '1px solid var(--border)',
            borderRadius: 8,
          }}
        >
          <p style={{ fontSize: 13, color: 'var(--fg-muted)', margin: 0 }}>
            No storyboard yet.{' '}
            <Link to={`/project/${projectId}/recordings`} style={{ color: 'var(--accent)' }}>
              Upload recordings
            </Link>{' '}
            to get started.
          </p>
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
        background: 'var(--bg-elev)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)',
        padding: 20,
      }}
    >
      <div
        style={{
          fontSize: 12,
          color: 'var(--fg-muted)',
          textTransform: 'uppercase',
          letterSpacing: 1,
          marginBottom: 12,
        }}
      >
        Scenes
      </div>
      <div style={{ display: 'grid', gap: 8 }}>
        {scenes.map((scene, i) => (
          <SceneRow key={scene.id} index={i} scene={scene} projectId={projectId} />
        ))}
      </div>
    </div>
  );
}

function SceneRow({ index, scene, projectId }: { index: number; scene: Scene; projectId: string }) {
  const status = statusOf(scene);
  const audioSec = totalNarrationDuration(scene);
  const chunkCount = scene.narration?.chunks?.length ?? 0;
  const mode = scene.narration?.mode;
  const hasRecording = !!scene.recording;

  return (
    <Link
      to={`/project/${projectId}/scene/${scene.id}?tab=Narration`}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 14px',
        background: 'var(--surface)',
        borderRadius: 'var(--radius-sm)',
        border: '1px solid var(--border)',
        textDecoration: 'none',
        color: 'inherit',
        transition: 'border-color 120ms',
      }}
      onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'var(--accent)')}
      onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'var(--border)')}
    >
      <StatusIcon status={status} />
      <span
        style={{
          fontSize: 11,
          color: 'var(--fg-muted)',
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          fontVariantNumeric: 'tabular-nums',
          minWidth: 24,
        }}
      >
        {String(index + 1).padStart(2, '0')}
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
        <div
          style={{
            fontSize: 12,
            color: 'var(--fg-muted)',
            marginTop: 2,
            display: 'flex',
            gap: 12,
            flexWrap: 'wrap',
            alignItems: 'center',
          }}
        >
          {status === 'narrated' && (
            <>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <Volume2 size={11} strokeWidth={1.8} aria-hidden />
                {audioSec > 0 ? formatDuration(audioSec) : '—'}
              </span>
              {chunkCount > 0 && (
                <span>
                  {chunkCount} chunk{chunkCount === 1 ? '' : 's'}
                </span>
              )}
              {mode && <span style={{ textTransform: 'capitalize' }}>{mode}</span>}
            </>
          )}
          {status === 'script-only' && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <FileText size={11} strokeWidth={1.8} aria-hidden />
              Script ready · audio not generated
            </span>
          )}
          {status === 'empty' && (
            <span style={{ color: 'var(--fg-dim)' }}>
              {hasRecording ? 'No narration' : 'No recording yet'}
            </span>
          )}
        </div>
      </div>
      <span
        style={{
          fontSize: 12,
          color: 'var(--fg-muted)',
          padding: '4px 10px',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-sm)',
        }}
      >
        {status === 'empty' && hasRecording ? '+ Add' : 'Open'}
      </span>
    </Link>
  );
}

function StatusIcon({ status }: { status: Status }) {
  if (status === 'narrated') {
    return (
      <span
        style={{
          width: 24,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: STATUS_COLOR.success,
        }}
      >
        <CheckCircle2 size={18} strokeWidth={1.8} aria-hidden />
      </span>
    );
  }
  if (status === 'script-only') {
    return (
      <span
        style={{
          width: 24,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: STATUS_COLOR.warn,
        }}
      >
        <FileText size={18} strokeWidth={1.8} aria-hidden />
      </span>
    );
  }
  return (
    <span
      style={{
        width: 24,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--fg-dim)',
      }}
    >
      <Circle size={18} strokeWidth={1.5} aria-hidden />
    </span>
  );
}
