/**
 * Lower Thirds page — project-wide list of every scene + its LT count.
 *
 * Same pattern as NarrationPage: surfaces cross-scene status so the sidebar
 * link has a real destination. Each row deep-links into the scene's Lower
 * Thirds tab where the actual editing happens.
 *
 * Lower-thirds are optional — render-time toggle decides whether they're
 * burned into the final video.
 */

import { useParams, useOutletContext, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Circle, Tag } from 'lucide-react';
import { storyboardApi } from '../lib/api.js';
import { STATUS_COLOR } from '../lib/palette.js';
import type { ProjectTrackerEntry, Scene } from '@vpa/shared';

interface WorkspaceContext {
  project: ProjectTrackerEntry;
}

function formatTimeRange(startSec: number, endSec: number): string {
  return `${startSec.toFixed(0)}s – ${endSec.toFixed(0)}s`;
}

export function LowerThirdsPage() {
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
  const withLts = scenes.filter((s) => (s.lower_thirds?.length ?? 0) > 0);
  const totalLts = scenes.reduce((sum, s) => sum + (s.lower_thirds?.length ?? 0), 0);

  return (
    <div style={{ padding: '40px 48px', maxWidth: 900 }}>
      <h1 style={{ margin: 0, fontSize: 24 }}>Lower Thirds</h1>
      <p style={{ color: 'var(--fg-muted)', marginTop: 4, fontSize: 13 }}>
        {!hasStoryboard
          ? 'Build a storyboard first — lower-thirds attach to each scene.'
          : withLts.length === 0
            ? 'Lower-thirds are optional. Add them scene-by-scene below, or render without them.'
            : `${withLts.length} of ${scenes.length} scenes have lower-thirds · ${totalLts} total.`}
      </p>

      {hasStoryboard && (
        <div style={{ marginTop: 24 }}>
          <SceneList scenes={scenes} projectId={projectId!} />

          {withLts.length === 0 && (
            <p
              style={{
                marginTop: 16,
                fontSize: 12,
                color: 'var(--fg-muted)',
                lineHeight: 1.6,
              }}
            >
              Don't need them? Uncheck "Include lower thirds" on the{' '}
              <Link to={`/project/${projectId}#render`} style={{ color: 'var(--accent)' }}>
                render
              </Link>{' '}
              page.
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
  const lts = scene.lower_thirds ?? [];
  const hasLts = lts.length > 0;
  const hasRecording = !!scene.recording;

  return (
    <Link
      to={`/project/${projectId}/scene/${scene.id}?tab=Lower%20Thirds`}
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
      <span
        style={{
          width: 24,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: hasLts ? STATUS_COLOR.success : 'var(--fg-dim)',
        }}
      >
        {hasLts ? (
          <CheckCircle2 size={18} strokeWidth={1.8} aria-hidden />
        ) : (
          <Circle size={18} strokeWidth={1.5} aria-hidden />
        )}
      </span>
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
            gap: 10,
            alignItems: 'center',
            flexWrap: 'wrap',
          }}
        >
          {hasLts ? (
            <>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <Tag size={11} strokeWidth={1.8} aria-hidden />
                {lts.length} item{lts.length === 1 ? '' : 's'}
              </span>
              {/* First couple of titles inline so the user sees what's there
                  without opening the scene. Truncated past two entries to keep
                  the row compact. */}
              <span
                style={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  maxWidth: 400,
                }}
              >
                {lts.slice(0, 2).map((lt) => `“${lt.title}”`).join(', ')}
                {lts.length > 2 && ` · +${lts.length - 2} more`}
              </span>
              <span style={{ color: 'var(--fg-dim)' }}>
                {formatTimeRange(lts[0]!.in_sec, lts[lts.length - 1]!.out_sec)}
              </span>
            </>
          ) : (
            <span style={{ color: 'var(--fg-dim)' }}>
              {hasRecording ? 'No lower-thirds' : 'No recording yet'}
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
        {hasLts ? 'Open' : hasRecording ? '+ Add' : 'Open'}
      </span>
    </Link>
  );
}
