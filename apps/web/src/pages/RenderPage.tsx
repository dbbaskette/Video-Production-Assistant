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
import { storyboardApi } from '../lib/api.js';
import { ProjectMusicAndRender } from './ProjectOverview.js';
import type { ProjectTrackerEntry } from '@vpa/shared';

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
