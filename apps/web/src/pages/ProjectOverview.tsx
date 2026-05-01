import { useState } from 'react';
import { Link, useOutletContext, useParams } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { storyboardApi, qualityReviewApi, exportApi } from '../lib/api.js';
import type { ProjectTrackerEntry } from '@vpa/shared';

interface WorkspaceContext {
  project: ProjectTrackerEntry;
}

export function ProjectOverview() {
  const { project } = useOutletContext<WorkspaceContext>();
  const { projectId } = useParams<{ projectId: string }>();

  const { data: storyboard } = useQuery({
    queryKey: ['storyboard', projectId],
    queryFn: () => storyboardApi.get(projectId!),
    enabled: !!projectId,
  });

  const { data: review } = useQuery({
    queryKey: ['review', projectId],
    queryFn: () => qualityReviewApi.get(projectId!),
    enabled: !!projectId,
  });

  const sceneCount = storyboard?.scenes?.length ?? 0;
  const hasStoryboard = storyboard !== null && storyboard !== undefined;
  const recordingCount = storyboard?.scenes?.filter((s) => s.recording).length ?? 0;
  const narrationCount = storyboard?.scenes?.filter((s) => s.narration?.audio).length ?? 0;

  return (
    <div style={{ padding: '40px 48px', maxWidth: 800 }}>
      <h1 style={{ margin: 0, fontSize: 24 }}>{project.name}</h1>
      <p style={{ color: 'var(--fg-muted)', marginTop: 4, fontSize: 13 }}>
        {project.path}
      </p>

      {/* Status cards */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 16,
          marginTop: 32,
        }}
      >
        <div
          style={{
            background: 'var(--bg-elev)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: 20,
          }}
        >
          <div style={{ fontSize: 12, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: 1 }}>
            Storyboard
          </div>
          <div style={{ fontSize: 28, fontWeight: 700, marginTop: 8 }}>
            {hasStoryboard ? `${sceneCount} scenes` : '—'}
          </div>
          <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 4 }}>
            {hasStoryboard ? 'Created' : 'Not started'}
          </div>
        </div>

        <div
          style={{
            background: 'var(--bg-elev)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: 20,
          }}
        >
          <div style={{ fontSize: 12, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: 1 }}>
            Recordings
          </div>
          <div style={{ fontSize: 28, fontWeight: 700, marginTop: 8 }}>
            {hasStoryboard ? `${recordingCount}/${sceneCount}` : '—'}
          </div>
          <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 4 }}>
            {recordingCount > 0
              ? recordingCount === sceneCount
                ? 'All recorded'
                : `${sceneCount - recordingCount} remaining`
              : 'Not started'}
          </div>
        </div>

        <div
          style={{
            background: 'var(--bg-elev)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: 20,
          }}
        >
          <div style={{ fontSize: 12, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: 1 }}>
            Narration
          </div>
          <div style={{ fontSize: 28, fontWeight: 700, marginTop: 8 }}>
            {hasStoryboard ? `${narrationCount}/${sceneCount}` : '—'}
          </div>
          <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 4 }}>
            {narrationCount > 0
              ? narrationCount === sceneCount
                ? 'All narrated'
                : `${sceneCount - narrationCount} remaining`
              : 'Not started'}
          </div>
        </div>

        <div
          style={{
            background: 'var(--bg-elev)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: 20,
          }}
        >
          <div style={{ fontSize: 12, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: 1 }}>
            Quality Review
          </div>
          <div
            style={{
              fontSize: 28,
              fontWeight: 700,
              marginTop: 8,
              color: review?.status === 'ok'
                ? '#5e8a3a'
                : review?.status === 'warnings'
                  ? '#f4a83a'
                  : review?.status === 'issues'
                    ? '#c25d5d'
                    : 'var(--fg)',
            }}
          >
            {review?.status === 'ok'
              ? 'Pass'
              : review?.status === 'warnings'
                ? `${review.summary.warn} warns`
                : review?.status === 'issues'
                  ? `${review.summary.issue} issues`
                  : '—'}
          </div>
          <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 4 }}>
            {review?.status ? 'Reviewed' : 'Not reviewed'}
          </div>
        </div>
      </div>

      {/* Action buttons */}
      <div style={{ marginTop: 32, display: 'flex', gap: 12 }}>
        {!hasStoryboard ? (
          <>
            <Link
              to={`/project/${project.id}/ideation`}
              style={{
                padding: '12px 24px',
                background: 'var(--accent-bg)',
                border: '1px solid var(--accent)',
                borderRadius: 8,
                color: 'var(--fg)',
                textDecoration: 'none',
                fontWeight: 600,
              }}
            >
              Start Ideation
            </Link>
            <Link
              to={`/project/${project.id}/recordings`}
              style={{
                padding: '12px 24px',
                background: 'var(--bg-elev)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                color: 'var(--fg)',
                textDecoration: 'none',
              }}
            >
              Upload Recordings
            </Link>
          </>
        ) : (
          <>
            <Link
              to={`/project/${project.id}/storyboard`}
              style={{
                padding: '12px 24px',
                background: 'var(--accent-bg)',
                border: '1px solid var(--accent)',
                borderRadius: 8,
                color: 'var(--fg)',
                textDecoration: 'none',
                fontWeight: 600,
              }}
            >
              View Storyboard
            </Link>
            <Link
              to={`/project/${project.id}/ideation`}
              style={{
                padding: '12px 24px',
                background: 'var(--bg-elev)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                color: 'var(--fg)',
                textDecoration: 'none',
              }}
            >
              Continue Ideation
            </Link>
            <Link
              to={`/project/${project.id}/review`}
              style={{
                padding: '12px 24px',
                background: 'var(--bg-elev)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                color: 'var(--fg)',
                textDecoration: 'none',
              }}
            >
              Quality Review
            </Link>
            <ExportButton projectId={project.id} />
          </>
        )}
      </div>
    </div>
  );
}

function ExportButton({ projectId }: { projectId: string }) {
  const [exportDir, setExportDir] = useState<string | null>(null);

  const exportMutation = useMutation({
    mutationFn: () => exportApi.run(projectId),
    onSuccess: (data) => setExportDir(data.exportDir),
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <button
        onClick={() => exportMutation.mutate()}
        disabled={exportMutation.isPending}
        style={{
          padding: '12px 24px',
          background: exportMutation.isPending ? 'var(--bg-elev)' : 'var(--accent)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          color: '#fff',
          cursor: exportMutation.isPending ? 'wait' : 'pointer',
          fontWeight: 600,
          fontSize: 14,
        }}
      >
        {exportMutation.isPending ? 'Exporting...' : 'Export Assets'}
      </button>
      {exportDir && (
        <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
          Exported to: {exportDir}
        </span>
      )}
      {exportMutation.isError && (
        <span style={{ fontSize: 11, color: 'var(--danger)' }}>
          {exportMutation.error instanceof Error ? exportMutation.error.message : 'Export failed'}
        </span>
      )}
    </div>
  );
}
