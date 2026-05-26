/**
 * Render page — dedicated home for music selection + final-video rendering.
 *
 * Used to live as a scroll-down section on the project Overview. Promoted to
 * its own page so the sidebar "Render" entry has a real destination that
 * matches the new Narration / Lower Thirds / Recordings pattern: header,
 * subtitle, body. No more `#render` hash hack.
 *
 * The actual rendering UI is still the `ProjectMusicAndRender` component
 * exported from `ProjectOverview.tsx`; this page is mostly a thin wrapper so
 * the page chrome (title + path subtitle + empty-state) is consistent across
 * the project pages.
 */

import { useParams, useOutletContext, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { storyboardApi, BASE as API_BASE } from '../lib/api.js';
import { ProjectMusicAndRender } from './ProjectOverview.js';
import type { ProjectTrackerEntry, Storyboard, SceneTransition } from '@vpa/shared';

interface WorkspaceContext {
  project: ProjectTrackerEntry;
}

export function RenderPage() {
  const { project } = useOutletContext<WorkspaceContext>();
  const { projectId } = useParams<{ projectId: string }>();

  const { data: storyboard } = useQuery({
    queryKey: ['storyboard', projectId],
    queryFn: () => storyboardApi.get(projectId!),
    enabled: !!projectId,
  });

  const sceneCount = storyboard?.scenes?.length ?? 0;
  const recordedCount = storyboard?.scenes?.filter((s) => s.recording).length ?? 0;
  const hasStoryboard = sceneCount > 0;
  const hasAnyRecording = recordedCount > 0;

  return (
    <div style={{ padding: '40px 48px', maxWidth: 900 }}>
      <h1 style={{ margin: 0, fontSize: 24 }}>Render</h1>
      <p style={{ color: 'var(--fg-muted)', marginTop: 4, fontSize: 13 }}>
        {!hasStoryboard
          ? 'Build a storyboard first — render combines every scene\'s recording into the final video.'
          : !hasAnyRecording
            ? 'Upload at least one recording before rendering.'
            : `Mix background music, pick what to include, and produce the final ${project.name}.mp4.`}
      </p>

      {hasStoryboard && hasAnyRecording ? (
        <div style={{ marginTop: 24 }}>
          {/* Scene strip — horizontal thumbnails so the user can confirm
              ordering + transitions at a glance before kicking off a
              multi-minute render. Sits above the render controls because
              it's review-context, not an action. */}
          <SceneStrip projectId={project.id} storyboard={storyboard!} />
          <ProjectMusicAndRender
            projectId={project.id}
            projectName={project.name}
            hasStoryboard={hasStoryboard}
          />
        </div>
      ) : (
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
            {!hasStoryboard ? 'No storyboard yet. ' : 'No recordings yet. '}
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

// Map our transition labels to a single-character icon for the strip.
// `cut` and undefined render as just a divider line.
const TRANSITION_ICON: Record<string, string> = {
  'crossfade': '✕',
  'fade-black': '◐',
  'fade-white': '◑',
  'wipe-left': '◀',
  'wipe-right': '▶',
  'slide-left': '⇐',
  'slide-right': '⇒',
  'slide-up': '⇑',
  'slide-down': '⇓',
  'circleopen': '◯',
  'circleclose': '⬤',
  'radial': '◉',
  'pixelize': '▦',
};

function SceneStrip({ projectId, storyboard }: { projectId: string; storyboard: Storyboard }) {
  const scenes = storyboard.scenes;
  if (scenes.length === 0) return null;

  return (
    <div
      style={{
        marginBottom: 20,
        padding: 14,
        background: 'var(--bg-elev)',
        border: '1px solid var(--border)',
        borderRadius: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 10 }}>
        <h3 style={{ margin: 0, fontSize: 13 }}>Scene order</h3>
        <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
          {scenes.length} scene{scenes.length === 1 ? '' : 's'} · transitions shown between
        </span>
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          overflowX: 'auto',
          paddingBottom: 4,
        }}
      >
        {scenes.map((scene, i) => {
          const isLast = i === scenes.length - 1;
          const transition = (scene.transition ?? 'cut') as SceneTransition | 'cut';
          const transitionDur = scene.transition_duration_sec;
          return (
            <SceneStripItem
              key={scene.id}
              projectId={projectId}
              sceneId={scene.id}
              sceneName={scene.name}
              hasRecording={!!scene.recording?.source}
              order={i + 1}
              transition={isLast ? null : transition}
              transitionDurationSec={isLast ? null : transitionDur}
            />
          );
        })}
      </div>
    </div>
  );
}

function SceneStripItem({
  projectId,
  sceneId,
  sceneName,
  hasRecording,
  order,
  transition,
  transitionDurationSec,
}: {
  projectId: string;
  sceneId: string;
  sceneName: string;
  hasRecording: boolean;
  order: number;
  transition: SceneTransition | 'cut' | null;
  transitionDurationSec: number | null | undefined;
}) {
  return (
    <>
      <Link
        to={`/project/${projectId}/storyboard?scene=${encodeURIComponent(sceneId)}`}
        style={{
          flex: '0 0 auto',
          width: 140,
          textDecoration: 'none',
          color: 'inherit',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          overflow: 'hidden',
          transition: 'border-color 120ms',
        }}
        onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'var(--accent)')}
        onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'var(--border)')}
        title={sceneName}
      >
        <div
          style={{
            aspectRatio: '16 / 10',
            background: '#0a0a0a',
            position: 'relative',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {hasRecording ? (
            <img
              src={`${API_BASE}/api/projects/${projectId}/scenes/${sceneId}/thumbnail`}
              alt=""
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              loading="lazy"
            />
          ) : (
            <span style={{ fontSize: 11, color: 'var(--fg-dim)' }}>no recording</span>
          )}
          <span
            style={{
              position: 'absolute',
              top: 4,
              left: 4,
              padding: '1px 6px',
              borderRadius: 3,
              background: 'rgba(0, 0, 0, 0.7)',
              color: '#fff',
              fontSize: 10,
              fontWeight: 600,
              fontFamily: "'JetBrains Mono', ui-monospace, monospace",
            }}
          >
            {String(order).padStart(2, '0')}
          </span>
        </div>
        <div style={{ padding: '6px 8px', fontSize: 11, lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {sceneName}
        </div>
      </Link>
      {transition && (
        <div
          style={{
            flex: '0 0 auto',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 2,
            padding: '0 4px',
            color: transition === 'cut' ? 'var(--fg-dim)' : 'var(--accent)',
            fontSize: 16,
            minWidth: 28,
          }}
          title={
            transition === 'cut'
              ? 'Hard cut'
              : `${transition} · ${(transitionDurationSec ?? 0.5).toFixed(1)}s`
          }
        >
          <span style={{ fontWeight: 700 }}>
            {transition === 'cut' ? '|' : TRANSITION_ICON[transition] ?? '◇'}
          </span>
          {transition !== 'cut' && (
            <span style={{ fontSize: 9, color: 'var(--fg-muted)', fontFamily: "'JetBrains Mono', ui-monospace, monospace" }}>
              {(transitionDurationSec ?? 0.5).toFixed(1)}s
            </span>
          )}
        </div>
      )}
    </>
  );
}
