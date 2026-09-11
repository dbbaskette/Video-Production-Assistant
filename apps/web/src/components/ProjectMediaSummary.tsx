import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { BASE, renderApi, storyboardApi, workflowStatusApi } from '../lib/api.js';

export function ProjectMediaSummary({
  projectId,
  compact = false,
}: {
  projectId: string;
  compact?: boolean;
}) {
  const storyboard = useQuery({
    queryKey: ['storyboard', projectId],
    queryFn: () => storyboardApi.get(projectId),
    staleTime: 30_000,
  });
  const workflow = useQuery({
    queryKey: ['workflow-status', projectId],
    queryFn: () => workflowStatusApi.get(projectId),
    staleTime: 30_000,
    refetchInterval: compact ? false : 5000,
  });
  const scenes = storyboard.data?.scenes ?? [];
  const first = scenes.find((scene) => scene.recording?.source);
  const output = workflow.data?.render.output;
  const label =
    output?.state === 'current'
      ? 'Video ready'
      : output?.state === 'stale'
        ? 'Video needs updating'
        : output?.state === 'in_progress'
          ? 'Rendering'
          : scenes.length
            ? `${scenes.length} scenes`
            : storyboard.isPending
              ? 'Loading project…'
              : storyboard.isError
                ? 'Project details unavailable'
                : 'Ready to start';
  if (compact)
    return (
      <span className="project-media-compact">
        {first && (
          <img
            loading="lazy"
            src={`${BASE}/api/projects/${projectId}/scenes/${first.id}/thumbnail`}
            alt=""
            onError={(event) => {
              event.currentTarget.style.visibility = 'hidden';
            }}
          />
        )}
        <span>{label}</span>
      </span>
    );
  if (storyboard.isPending || workflow.isPending)
    return <p role="status">Loading project preview…</p>;
  if (storyboard.isError || workflow.isError)
    return (
      <p role="alert">
        Could not load the project preview.{' '}
        <button
          type="button"
          onClick={() => {
            void storyboard.refetch();
            void workflow.refetch();
          }}
        >
          Retry
        </button>
      </p>
    );
  return (
    <section className="project-media-summary" aria-label="Current project video">
      {output && (output.state === 'current' || output.state === 'stale') ? (
        <>
          <video controls playsInline preload="metadata" src={renderApi.videoUrl(projectId)} />
          <div>
            <strong>{label}</strong>
            {(output.completedAt ?? output.modifiedAt) && (
              <p>
                Export version ·{' '}
                <time dateTime={output.completedAt ?? output.modifiedAt}>
                  {new Date((output.completedAt ?? output.modifiedAt)!).toLocaleString()}
                </time>
              </p>
            )}
            <p>
              {output.state === 'stale'
                ? 'This is the previous export. Review changed inputs before rendering again.'
                : 'Latest exported video. Review or download this result.'}
            </p>
            <Link className="primary" to={`/project/${projectId}/render`}>
              Review & export
            </Link>
            <a href={`${renderApi.videoUrl(projectId)}?download=1`}>
              Download {output.state === 'stale' ? 'previous' : 'video'}
            </a>
          </div>
        </>
      ) : first ? (
        <Link
          to={`/project/${projectId}/storyboard?scene=${encodeURIComponent(first.id)}`}
          className="project-source-preview"
        >
          <img
            src={`${BASE}/api/projects/${projectId}/scenes/${first.id}/thumbnail`}
            alt={`Preview ${first.name}`}
          />
          <span>Open scenes · {scenes.length} scenes</span>
        </Link>
      ) : (
        <div className="project-start">
          <h2>What are you making?</h2>
          <p>Start with an idea, a presentation, or existing recordings.</p>
          <Link className="primary" to={`/project/${projectId}/ideation`}>
            Plan your video
          </Link>
          <Link to={`/project/${projectId}/recordings`}>Import recordings</Link>
          <Link to={`/project/${projectId}/storyboard`}>Add presentation</Link>
        </div>
      )}
    </section>
  );
}
