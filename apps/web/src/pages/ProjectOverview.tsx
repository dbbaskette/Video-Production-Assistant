import { useEffect, useRef, useState } from 'react';
import { Link, useOutletContext, useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { storyboardApi, qualityReviewApi, exportApi, api, brandsApi, renderApi } from '../lib/api.js';
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

      {/* Brand applied to this project */}
      <ProjectBrandSection projectId={project.id} />

      <RenderSection projectId={project.id} hasStoryboard={hasStoryboard} />

      {/* Action buttons */}
      <div style={{ marginTop: 32, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
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
              Recordings
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

      {/* Workflow guide */}
      {hasStoryboard && (
        <div style={{ marginTop: 32 }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Per-Scene Workflow</div>
          <p style={{ color: 'var(--fg-muted)', fontSize: 13, margin: '0 0 12px', lineHeight: 1.6 }}>
            Click any scene in the sidebar to access its full editing pipeline:
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
            {[
              { icon: '📹', title: 'Recording', desc: 'Upload screen recording' },
              { icon: '📝', title: 'Script', desc: 'Write or AI-generate narration script' },
              { icon: '🔊', title: 'Narration', desc: 'Select TTS engine, voice & speed' },
              { icon: '🏷️', title: 'Lower Thirds', desc: 'Add title/subtitle overlays' },
            ].map((step) => (
              <div
                key={step.title}
                style={{
                  background: 'var(--bg-elev)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '14px 16px',
                  textAlign: 'center',
                }}
              >
                <div style={{ fontSize: 22, marginBottom: 6 }}>{step.icon}</div>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{step.title}</div>
                <div style={{ fontSize: 11, color: 'var(--fg-muted)', lineHeight: 1.4 }}>{step.desc}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

interface RenderProgressEvent {
  type: 'step';
  step: 'concat-audio' | 'mux-scene' | 'concat-scenes' | 'done';
  sceneIndex?: number;
  sceneId?: string;
  totalScenes?: number;
  message: string;
}

function RenderSection({ projectId, hasStoryboard }: { projectId: string; hasStoryboard: boolean }) {
  const queryClient = useQueryClient();
  const [progress, setProgress] = useState<RenderProgressEvent | null>(null);
  const [doneAt, setDoneAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [audioMode, setAudioMode] = useState<'replace' | 'mix'>('replace');
  const [burnSubtitles, setBurnSubtitles] = useState(false);
  const closeStreamRef = useRef<(() => void) | null>(null);

  const status = useQuery({
    queryKey: ['render-status', projectId],
    queryFn: () => renderApi.status(projectId),
    enabled: hasStoryboard,
  });

  const startRender = useMutation({
    mutationFn: () => renderApi.start(projectId, { audioMode, burnSubtitles }),
    onSuccess: ({ jobId }) => {
      setError(null);
      setProgress(null);
      setDoneAt(null);
      // Subscribe to SSE for progress
      closeStreamRef.current?.();
      const close = renderApi.subscribe(jobId, (raw) => {
        // Each event from the queue is shaped as { type, timestamp, data }.
        const evt = raw as { type: string; data?: unknown };
        if (evt.type === 'progress' && evt.data) {
          setProgress(evt.data as RenderProgressEvent);
        } else if (evt.type === 'done') {
          setProgress(null);
          setDoneAt(Date.now());
          queryClient.invalidateQueries({ queryKey: ['render-status', projectId] });
          closeStreamRef.current?.();
          closeStreamRef.current = null;
        } else if (evt.type === 'error') {
          const data = evt.data as { error?: string } | undefined;
          setError(data?.error ?? 'Render failed');
          setProgress(null);
          closeStreamRef.current?.();
          closeStreamRef.current = null;
        }
      });
      closeStreamRef.current = close;
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Failed to start render'),
  });

  useEffect(() => {
    return () => {
      closeStreamRef.current?.();
    };
  }, []);

  if (!hasStoryboard) return null;

  const exists = status.data?.exists;
  const sizeMb = exists && status.data?.sizeBytes ? (status.data.sizeBytes / 1024 / 1024).toFixed(1) : null;
  const isRunning = startRender.isPending || progress !== null;
  const progressPct = progress && progress.totalScenes && progress.sceneIndex !== undefined
    ? Math.round(((progress.sceneIndex + (progress.step === 'mux-scene' ? 0.5 : 0)) / progress.totalScenes) * 100)
    : progress?.step === 'concat-scenes' ? 95 : null;

  return (
    <div
      style={{
        marginTop: 32,
        background: 'var(--bg-elev)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: 20,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 12, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: 1 }}>
            Finished Video
          </div>
          <div style={{ fontSize: 16, fontWeight: 600, marginTop: 4 }}>
            {exists
              ? <>Ready · {sizeMb} MB · <span style={{ fontSize: 12, color: 'var(--fg-muted)', fontWeight: 400 }}>last rendered {timeAgo(status.data?.modifiedAt)}</span></>
              : 'Not rendered yet'}
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
            disabled={isRunning}
            style={{ padding: '4px 8px', background: 'var(--bg)', color: 'var(--fg)', border: '1px solid var(--border)', borderRadius: 4 }}
          >
            <option value="replace">replace original</option>
            <option value="mix">mix narration over original (-20dB)</option>
          </select>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            type="checkbox"
            checked={burnSubtitles}
            onChange={(e) => setBurnSubtitles(e.target.checked)}
            disabled={isRunning}
          />
          Burn in subtitles
        </label>
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          onClick={() => startRender.mutate()}
          disabled={isRunning}
          className="btn--accent"
          style={{ padding: '10px 20px', fontSize: 14 }}
        >
          {isRunning ? 'Rendering…' : exists ? 'Re-render Finished Video' : 'Render Finished Video'}
        </button>
        {exists && (
          <>
            <a
              href={renderApi.videoUrl(projectId)}
              download="final.mp4"
              style={{ fontSize: 13, color: 'var(--accent)', textDecoration: 'none' }}
            >
              Download
            </a>
            <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
              ready-to-share mp4 with narration + lower thirds baked in
            </span>
          </>
        )}
      </div>

      {/* Progress */}
      {progress && (
        <div style={{ marginTop: 12 }}>
          <div style={{
            background: 'var(--bg)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            height: 8,
            overflow: 'hidden',
          }}>
            <div
              style={{
                background: 'var(--accent)',
                height: '100%',
                width: `${progressPct ?? 0}%`,
                transition: 'width 200ms',
              }}
            />
          </div>
          <p style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 6 }}>
            {progress.message}
            {progressPct !== null && ` (${progressPct}%)`}
          </p>
        </div>
      )}

      {error && (
        <p style={{ fontSize: 13, color: 'var(--danger)', marginTop: 12, whiteSpace: 'pre-wrap' }}>
          {error}
        </p>
      )}

      {/* Inline player */}
      {(exists || doneAt) && !isRunning && (
        <video
          key={status.data?.modifiedAt ?? doneAt}
          src={renderApi.videoUrl(projectId)}
          controls
          playsInline
          preload="metadata"
          style={{
            display: 'block',
            width: '100%',
            maxWidth: 720,
            marginTop: 16,
            borderRadius: 6,
            background: '#000',
          }}
        />
      )}
    </div>
  );
}

function timeAgo(iso?: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

function ProjectBrandSection({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();

  const { data: project } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.getProject(projectId),
  });

  const { data: registry } = useQuery({
    queryKey: ['brands'],
    queryFn: () => brandsApi.list(),
  });

  const setBrand = useMutation({
    mutationFn: (brand: { id: string; applied_version: number } | null) =>
      api.setProjectBrand(projectId, brand),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project', projectId] });
    },
  });

  const appliedBrandId = project?.brand?.id ?? null;
  const appliedBrand = registry?.brands.find((b) => b.id === appliedBrandId) ?? null;

  return (
    <div
      style={{
        marginTop: 32,
        background: 'var(--bg-elev)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: 20,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          marginBottom: 12,
        }}
      >
        <div>
          <div style={{ fontSize: 12, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: 1 }}>
            Brand
          </div>
          <div style={{ fontSize: 16, fontWeight: 600, marginTop: 4 }}>
            {appliedBrand
              ? `${appliedBrand.name} (v${project?.brand?.applied_version ?? appliedBrand.version})`
              : 'No brand applied'}
          </div>
        </div>
        <Link
          to="/brands"
          style={{
            fontSize: 12,
            color: 'var(--fg-muted)',
            textDecoration: 'none',
            border: '1px solid var(--border)',
            padding: '4px 10px',
            borderRadius: 6,
          }}
        >
          Manage brands →
        </Link>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <select
          value={appliedBrandId ?? ''}
          onChange={(e) => {
            const id = e.target.value;
            if (!id) {
              setBrand.mutate(null);
              return;
            }
            const entry = registry?.brands.find((b) => b.id === id);
            if (entry) setBrand.mutate({ id: entry.id, applied_version: entry.version });
          }}
          disabled={setBrand.isPending || !registry}
          style={{
            padding: '6px 10px',
            borderRadius: 6,
            background: 'var(--bg)',
            color: 'var(--fg)',
            border: '1px solid var(--border)',
            fontSize: 13,
            minWidth: 200,
          }}
        >
          <option value="">— None —</option>
          {registry?.brands.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
              {b.id === registry.default_brand_id ? ' (default)' : ''}
            </option>
          ))}
        </select>
        {setBrand.isPending && <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>Saving...</span>}
        {setBrand.isError && (
          <span style={{ fontSize: 12, color: 'var(--danger)' }}>
            {setBrand.error instanceof Error ? setBrand.error.message : 'Save failed'}
          </span>
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
        {exportMutation.isPending ? 'Exporting…' : 'Export Source Assets'}
      </button>
      {exportDir && (
        <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
          Exported to: {exportDir}
        </span>
      )}
      <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
        Bundle of source clips + narration + subtitles for an external editor (Final Cut, Premiere, etc.)
      </span>
      {exportMutation.isError && (
        <span style={{ fontSize: 11, color: 'var(--danger)' }}>
          {exportMutation.error instanceof Error ? exportMutation.error.message : 'Export failed'}
        </span>
      )}
    </div>
  );
}
