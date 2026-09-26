import { useState } from 'react';
import { useParams, useOutletContext, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { feedbackApi, qualityReviewApi, renderApi, revisionsApi, storyboardApi } from '../lib/api.js';
import type { ReviewItem } from '../lib/api.js';
import { SEVERITY_COLOR, reviewSummaryColor, reviewSummaryLabel } from '../lib/palette.js';
import type { ProjectTrackerEntry } from '@vpa/shared';
import { TightenScriptModal } from '../components/TightenScriptModal.js';
import { AssistancePanel } from '../components/AssistancePanel.js';
import {
  canTightenQualityReviewCategory,
  qualityReviewCategoryTab,
} from '../lib/quality-review.js';

interface WorkspaceContext {
  project: ProjectTrackerEntry;
}

// Severity palette + labels: single source of truth in lib/palette.ts.
// Local re-exports (kept named the same) so the rest of the file's JSX
// reads as before.
const severityColors = SEVERITY_COLOR;

const severityLabels: Record<string, string> = {
  info: 'Info',
  warn: 'Warning',
  issue: 'Issue',
};

export function ReviewPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const { project } = useOutletContext<WorkspaceContext>();
  const queryClient = useQueryClient();
  // When set, the tighten modal is open for this scene. null = closed.
  const [tightenSceneId, setTightenSceneId] = useState<string | null>(null);
  const [feedbackText, setFeedbackText] = useState('');
  const [feedbackSceneId, setFeedbackSceneId] = useState('');
  const [sourceInMs, setSourceInMs] = useState(0);
  const [sourceOutMs, setSourceOutMs] = useState(1000);
  const [includeRegion, setIncludeRegion] = useState(false);
  const [region, setRegion] = useState({ x: 0.2, y: 0.2, width: 0.6, height: 0.6 });

  const { data: review } = useQuery({
    queryKey: ['review', projectId],
    queryFn: () => qualityReviewApi.get(projectId!),
    enabled: !!projectId,
  });

  const { data: storyboard } = useQuery({
    queryKey: ['storyboard', projectId],
    queryFn: () => storyboardApi.get(projectId!),
    enabled: !!projectId,
  });

  const { data: renderStatus } = useQuery({
    queryKey: ['render-status', projectId], queryFn: () => renderApi.status(projectId!), enabled: !!projectId,
  });
  const { data: revisionState } = useQuery({
    queryKey: ['revisions', projectId], queryFn: () => revisionsApi.list(projectId!), enabled: !!projectId,
  });
  const { data: feedback } = useQuery({
    queryKey: ['feedback', projectId], queryFn: () => feedbackApi.list(projectId!), enabled: !!projectId,
  });

  const activeScene = storyboard?.scenes.find((scene) => scene.id === feedbackSceneId) ?? storyboard?.scenes.find((scene) => (scene.composition?.clips.length ?? 0) > 0);
  const activeClip = activeScene?.composition?.clips[0];

  const addFeedback = useMutation({
    mutationFn: () => feedbackApi.add(projectId!, {
      sceneId: activeScene!.id, clipInstanceId: activeClip!.id, sourceAssetId: activeClip!.source_asset_id,
      sourceInMs, sourceOutMs, text: feedbackText,
      ...(includeRegion ? { rect: region } : {}),
    }),
    onSuccess: () => { setFeedbackText(''); queryClient.invalidateQueries({ queryKey: ['feedback', projectId] }); queryClient.invalidateQueries({ queryKey: ['revisions', projectId] }); },
  });
  const restoreRevision = useMutation({
    mutationFn: (revision: number) => revisionsApi.restore(projectId!, revisionState!.currentRevision, revision),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['revisions', projectId] }); queryClient.invalidateQueries({ queryKey: ['storyboard', projectId] }); queryClient.invalidateQueries({ queryKey: ['render-status', projectId] }); },
  });

  const runMutation = useMutation({
    mutationFn: () => qualityReviewApi.run(projectId!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['review', projectId] });
    },
  });

  // Group items by scene
  const itemsByScene = new Map<string, ReviewItem[]>();
  if (review?.items) {
    for (const item of review.items) {
      const list = itemsByScene.get(item.sceneId) ?? [];
      list.push(item);
      itemsByScene.set(item.sceneId, list);
    }
  }
  const priorArtifacts = (renderStatus?.artifacts ?? []).filter((artifact) => artifact.artifactId !== renderStatus?.manifest?.artifactId);

  return (
    <div style={{ padding: '32px 48px', maxWidth: 1040 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>Review &amp; Export</h1>
        <button
          onClick={() => runMutation.mutate()}
          disabled={runMutation.isPending}
          style={{
            padding: '10px 20px',
            background: 'var(--accent)',
            color: '#fff',
            border: 'none',
            borderRadius: 6,
            cursor: runMutation.isPending ? 'wait' : 'pointer',
            fontSize: 13,
            fontWeight: 600,
            opacity: runMutation.isPending ? 0.7 : 1,
          }}
        >
          {runMutation.isPending ? 'Reviewing...' : 'Run Quality Review'}
        </button>
      </div>

      <section style={{ padding: 18, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
          <div>
            <strong style={{ fontSize: 14 }}>Current export</strong>
            {renderStatus?.manifest && <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 4 }}>Revision {renderStatus.manifest.revision} · {renderStatus.manifest.output.width ?? '?'}×{renderStatus.manifest.output.height ?? '?'} · {renderStatus.manifest.output.fps ?? '?'} fps · {Math.round(renderStatus.manifest.output.durationSec)}s</div>}
          </div>
          {renderStatus?.exists && <div style={{ display: 'flex', gap: 8 }}><a href={renderApi.videoUrl(projectId!)} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)', fontSize: 13 }}>Play</a><a href={renderApi.downloadUrl(projectId!, `${project.name}.mp4`)} style={{ color: 'var(--accent)', fontSize: 13 }}>Download</a></div>}
        </div>
        {!renderStatus?.exists && <p style={{ color: 'var(--fg-muted)', fontSize: 13, marginBottom: 0 }}>No export yet. Render the project to create a downloadable video.</p>}
        {renderStatus?.stale && <p style={{ color: 'var(--warning)', fontSize: 12, marginBottom: 0 }}>The project is now at revision {renderStatus.currentRevision}; this export remains available but is no longer current.</p>}
        {priorArtifacts.length > 0 && <details style={{ marginTop: 12 }}><summary style={{ cursor: 'pointer', fontSize: 12 }}>Other exports ({priorArtifacts.length})</summary>{priorArtifacts.map((artifact) => <div key={artifact.artifactId} style={{ display: 'flex', gap: 10, paddingTop: 8, fontSize: 12 }}><span>{artifact.variant ? `${artifact.variant.name} · ${artifact.variant.aspectRatio} · ` : ''}Revision {artifact.revision} · {new Date(artifact.completedAt).toLocaleString()}</span><a href={renderApi.videoUrl(projectId!, artifact.artifactId)} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>Play</a><a href={renderApi.downloadUrl(projectId!, `${project.name}${artifact.variant ? `-${artifact.variant.id}` : `-r${artifact.revision}`}.mp4`, artifact.artifactId)} style={{ color: 'var(--accent)' }}>Download</a></div>)}</details>}
      </section>

      <AssistancePanel projectId={projectId!} />

      <section style={{ padding: 18, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, marginBottom: 24 }}>
        <strong style={{ fontSize: 14 }}>Draft history</strong>
        <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 4 }}>Current revision {revisionState?.currentRevision ?? '—'} · accepted revision {revisionState?.acceptedRevision ?? '—'}</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
          {revisionState?.revisions.slice().reverse().slice(0, 8).map((revision) => {
            const detail = revisionState.details.find((item) => item.revision === revision.revision);
            const artifact = renderStatus?.artifacts?.find((item) => item.revision === revision.revision);
            return <div key={revision.revision} style={{ border: '1px solid var(--border)', borderRadius: 7, padding: 9, minWidth: 150, background: revision.revision === revisionState.currentRevision ? 'var(--accent-soft)' : 'transparent' }}>{detail?.firstSceneId && <img src={renderApi.thumbnailUrl(projectId!, detail.firstSceneId, revision.revision)} alt={`Revision ${revision.revision} preview`} style={{ width: 150, height: 84, objectFit: 'cover', borderRadius: 4, display: 'block', marginBottom: 7 }} />}<div style={{ fontSize: 12, fontWeight: 600 }}>r{revision.revision} · {revision.state}</div><div style={{ fontSize: 11, color: 'var(--fg-muted)', margin: '3px 0 7px' }}>{detail?.sceneCount ?? 0} scenes · {Math.round(detail?.durationSec ?? 0)}s<br />{detail?.summary ?? revision.commandTypes.join(', ')}{artifact ? <><br />Export {artifact.jobId.slice(0, 8)}{artifact.variant ? ` · ${artifact.variant.name} ${artifact.variant.aspectRatio}` : ''}</> : null}</div>{revision.revision !== revisionState.currentRevision && <button disabled={restoreRevision.isPending} onClick={() => restoreRevision.mutate(revision.revision)} style={{ fontSize: 11, padding: '4px 8px' }}>Restore exact revision</button>}</div>;
          })}
        </div>
      </section>

      <section style={{ padding: 18, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, marginBottom: 24 }}>
        <strong style={{ fontSize: 14 }}>Visual feedback</strong>
        <p style={{ fontSize: 12, color: 'var(--fg-muted)' }}>Anchor a note to a source clip and time range. Optionally attach the center region of the frame.</p>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 1fr) 110px 110px', gap: 8 }}>
          <select value={activeScene?.id ?? ''} onChange={(event) => setFeedbackSceneId(event.target.value)} style={{ padding: 8 }} aria-label="Feedback scene">{storyboard?.scenes.filter((scene) => (scene.composition?.clips.length ?? 0) > 0).map((scene) => <option key={scene.id} value={scene.id}>{scene.name}</option>)}</select>
          <input type="number" min={0} value={sourceInMs} onChange={(event) => setSourceInMs(Number(event.target.value))} aria-label="Start time milliseconds" style={{ padding: 8 }} />
          <input type="number" min={1} value={sourceOutMs} onChange={(event) => setSourceOutMs(Number(event.target.value))} aria-label="End time milliseconds" style={{ padding: 8 }} />
        </div>
        <textarea value={feedbackText} onChange={(event) => setFeedbackText(event.target.value)} placeholder="What should change here?" style={{ width: '100%', boxSizing: 'border-box', minHeight: 72, marginTop: 8, padding: 10 }} />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}><label style={{ fontSize: 12 }}><input type="checkbox" checked={includeRegion} onChange={(event) => setIncludeRegion(event.target.checked)} /> Attach frame region</label><button disabled={!activeClip || !feedbackText.trim() || sourceOutMs <= sourceInMs || addFeedback.isPending} onClick={() => addFeedback.mutate()} style={{ padding: '8px 14px', background: 'var(--accent)', color: '#fff', border: 0, borderRadius: 6 }}>Add feedback</button></div>
        {includeRegion && <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginTop: 8 }}>{(['x', 'y', 'width', 'height'] as const).map((key) => <label key={key} style={{ fontSize: 11, color: 'var(--fg-muted)' }}>{key}<input type="number" min={0} max={1} step={0.05} value={region[key]} onChange={(event) => setRegion((current) => ({ ...current, [key]: Number(event.target.value) }))} style={{ width: '100%', boxSizing: 'border-box', padding: 6 }} /></label>)}</div>}
        {(feedback?.notes.length ?? 0) > 0 && <div style={{ marginTop: 14 }}>{feedback!.notes.map((note) => <div key={note.id} style={{ borderTop: '1px solid var(--border)', padding: '10px 0', fontSize: 12 }}><strong>{note.status}</strong> · {note.scene_id} · {(note.source_in_ms / 1000).toFixed(1)}–{(note.source_out_ms / 1000).toFixed(1)}s<div style={{ marginTop: 3 }}>{note.text}</div>{note.resolving_revision != null && <div style={{ color: 'var(--fg-muted)' }}>Resolved by revision {note.resolving_revision}: {note.resolution}</div>}</div>)}</div>}
      </section>

      {runMutation.isError && (
        <p style={{ color: 'var(--danger)', fontSize: 13, marginBottom: 16 }}>
          Review failed:{' '}
          {runMutation.error instanceof Error ? runMutation.error.message : 'Unknown error'}
        </p>
      )}

      {/* Summary bar */}
      {review?.status && (
        <div
          style={{
            display: 'flex',
            gap: 24,
            padding: 16,
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            marginBottom: 24,
            alignItems: 'center',
          }}
        >
          {/* Status label + color come from lib/palette.ts so this matches
              the Project Overview status tile vocabulary. Same data, same
              words. */}
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: reviewSummaryColor(
                review.status === 'ok'
                  ? 'ready'
                  : review.status === 'warnings'
                    ? 'warnings'
                    : 'issues',
              ),
            }}
          >
            {reviewSummaryLabel(
              review.status === 'ok'
                ? 'ready'
                : review.status === 'warnings'
                  ? 'warnings'
                  : 'issues',
              { warnings: review.summary.warn, issues: review.summary.issue },
            )}
          </div>
          <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
            {review.summary.total} items: {review.summary.info} info, {review.summary.warn} warnings, {review.summary.issue} issues
          </div>
          {review.reviewedAt && (
            <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginLeft: 'auto' }}>
              Last reviewed: {new Date(review.reviewedAt).toLocaleString()}
            </div>
          )}
        </div>
      )}

      {/* Staleness hint — the review is a snapshot of the storyboard at
          `reviewedAt`. Any change since then (a new recording upload,
          generated narration, edited lower-thirds, etc.) means this review
          may be out of date. We don't have a server-side mtime for the
          storyboard so we can't be precise — instead we always remind the
          user when a review exists. Hidden when the review is less than a
          minute old (just-ran case). */}
      {review?.reviewedAt && review.stale && (
        <div
          style={{
            padding: '10px 14px',
            background: 'var(--bg-elev)',
            border: '1px dashed var(--border)',
            borderRadius: 6,
            marginBottom: 16,
            fontSize: 12,
            color: 'var(--fg-muted)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
          }}
        >
          <span>
            This review reflects the storyboard as of{' '}
            <strong>{new Date(review.reviewedAt).toLocaleString()}</strong>. If you've
            generated narration, uploaded recordings, or edited content since then, the
            findings may be out of date.
          </span>
          <button
            onClick={() => runMutation.mutate()}
            disabled={runMutation.isPending}
            style={{
              padding: '4px 12px',
              fontSize: 12,
              background: 'transparent',
              color: 'var(--accent)',
              border: '1px solid var(--accent)',
              borderRadius: 4,
              cursor: runMutation.isPending ? 'wait' : 'pointer',
              flexShrink: 0,
            }}
          >
            Re-run
          </button>
        </div>
      )}

      {/* No review yet */}
      {(!review?.status) && (
        <div
          style={{
            padding: 48,
            textAlign: 'center',
            color: 'var(--fg-muted)',
            border: '1px dashed var(--border)',
            borderRadius: 8,
          }}
        >
          <p style={{ fontSize: 14, marginBottom: 4 }}>No review has been run yet.</p>
          <p style={{ fontSize: 12 }}>
            Click <strong>Run Quality Review</strong> to inspect your storyboard for issues.
          </p>
        </div>
      )}

      {/* Items grouped by scene */}
      {review?.status && Array.from(itemsByScene.entries()).map(([sceneId, items]) => {
        const scene = storyboard?.scenes.find((s) => s.id === sceneId);
        return (
          <div
            key={sceneId}
            style={{
              marginBottom: 16,
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                padding: '12px 16px',
                borderBottom: '1px solid var(--border)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <span style={{ fontWeight: 600, fontSize: 14 }}>
                {scene?.name ?? sceneId}
              </span>
              <Link
                to={`/project/${projectId}/storyboard?scene=${encodeURIComponent(sceneId)}`}
                style={{ fontSize: 12, color: 'var(--accent)', textDecoration: 'none' }}
              >
                Go to scene
              </Link>
            </div>
            {items.map((item, idx) => {
              const tab = qualityReviewCategoryTab(item.category);
              const base = `/project/${projectId}/storyboard?scene=${encodeURIComponent(sceneId)}`;
              const target = tab ? `${base}&tab=${encodeURIComponent(tab)}` : base;
              // Narration warnings are usually "script too long for the clip".
              // The actionable fix is to tighten the script, not to tweak TTS
              // speed on the Narration tab — surface a recommend button that
              // does the right thing in one click.
              const canTighten = canTightenQualityReviewCategory(item.category);
              return (
                <div
                  key={idx}
                  style={{
                    display: 'flex',
                    gap: 12,
                    alignItems: 'flex-start',
                    padding: '10px 16px',
                    borderBottom: idx < items.length - 1 ? '1px solid var(--border)' : 'none',
                  }}
                >
                  <span
                    style={{
                      fontSize: 10,
                      padding: '2px 6px',
                      borderRadius: 3,
                      background: severityColors[item.severity] ?? '#666',
                      color: '#fff',
                      fontWeight: 600,
                      textTransform: 'uppercase',
                      whiteSpace: 'nowrap',
                      marginTop: 2,
                    }}
                  >
                    {severityLabels[item.severity] ?? item.severity}
                  </span>
                  <span style={{ flex: 1, fontSize: 13, color: 'var(--fg)' }}>{item.message}</span>
                  {canTighten && (
                    <button
                      onClick={() => setTightenSceneId(sceneId)}
                      style={{
                        padding: '4px 10px',
                        fontSize: 11,
                        background: 'var(--accent)',
                        color: '#fff',
                        border: 'none',
                        borderRadius: 4,
                        cursor: 'pointer',
                        fontWeight: 600,
                        whiteSpace: 'nowrap',
                      }}
                      title="Ask the LLM to shorten the script so the narration fits"
                    >
                      ✨ Tighten script
                    </button>
                  )}
                  <Link
                    to={target}
                    style={{
                      fontSize: 11,
                      color: 'var(--accent)',
                      whiteSpace: 'nowrap',
                      fontWeight: 500,
                      textDecoration: 'none',
                    }}
                    title={`Jump to ${tab ?? 'scene'}`}
                  >
                    {tab ? `Open ${tab} →` : 'Open scene →'}
                  </Link>
                </div>
              );
            })}
          </div>
        );
      })}

      {tightenSceneId && projectId && (
        <TightenScriptModal
          projectId={projectId}
          sceneId={tightenSceneId}
          sceneName={storyboard?.scenes.find((s) => s.id === tightenSceneId)?.name ?? tightenSceneId}
          onClose={() => setTightenSceneId(null)}
          onAccepted={() => {
            // The script changed — invalidate review (results are stale) and
            // any open script/storyboard queries.
            queryClient.invalidateQueries({ queryKey: ['review', projectId] });
            queryClient.invalidateQueries({ queryKey: ['storyboard', projectId] });
            queryClient.invalidateQueries({ queryKey: ['script', projectId, tightenSceneId] });
          }}
        />
      )}
    </div>
  );
}
