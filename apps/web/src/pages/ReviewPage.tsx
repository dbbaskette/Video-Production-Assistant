import { useEffect, useState } from 'react';
import { useParams, useOutletContext, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { qualityReviewApi, storyboardApi, scriptApi } from '../lib/api.js';
import type { ReviewItem } from '../lib/api.js';
import { SEVERITY_COLOR, reviewSummaryColor, reviewSummaryLabel } from '../lib/palette.js';
import type { ProjectTrackerEntry } from '@vpa/shared';

interface WorkspaceContext {
  project: ProjectTrackerEntry;
}

/**
 * Map a quality-review item's `category` to the relevant Scene-page tab so
 * clicking the issue jumps the user directly to where they need to act.
 * `general` and unknown categories fall through to no tab (just opens the
 * scene at its default tab).
 */
function categoryToTab(category: string): string | null {
  switch (category) {
    case 'recording': return 'Recording';
    case 'script':    return 'Script';
    case 'narration': return 'Narration';
    case 'lower_thirds': return 'Lower Thirds';
    case 'description': return null; // no dedicated tab; scene name/desc shown across
    case 'general': return null;
    default: return null;
  }
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

/**
 * Modal that asks the LLM to tighten a scene's script to fit its recording,
 * shows the proposal next to the current script, and on Accept saves the new
 * script via PUT. Used by Quality Review when a "narration too long for the
 * clip" warning lands — fixing that on the Narration tab only exposes speed,
 * which isn't the right knob; the script itself is.
 */
function TightenScriptModal({
  projectId,
  sceneId,
  sceneName,
  onClose,
  onAccepted,
}: {
  projectId: string;
  sceneId: string;
  sceneName: string;
  onClose: () => void;
  onAccepted: () => void;
}) {
  const tightenMutation = useMutation({
    mutationFn: () => scriptApi.tighten(projectId, sceneId),
  });
  const saveMutation = useMutation({
    mutationFn: (script: string) => scriptApi.save(projectId, sceneId, script),
    onSuccess: () => {
      onAccepted();
      onClose();
    },
  });

  // Kick off the tighten request the first time the modal opens.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { tightenMutation.mutate(); }, []);

  const data = tightenMutation.data;

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 1000, padding: 32,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--bg)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          padding: 24,
          maxWidth: 1000,
          width: '100%',
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>Tighten script — {sceneName}</h2>
          <button
            onClick={onClose}
            style={{ background: 'transparent', border: 'none', color: 'var(--fg-muted)', cursor: 'pointer', fontSize: 18 }}
          >
            ✕
          </button>
        </div>

        {tightenMutation.isPending && (
          <p style={{ color: 'var(--fg-muted)', fontSize: 13 }}>
            Asking the model to shorten the script to fit the recording…
          </p>
        )}

        {tightenMutation.isError && (
          <p style={{ color: 'var(--danger)', fontSize: 13 }}>
            Tighten failed:{' '}
            {tightenMutation.error instanceof Error ? tightenMutation.error.message : 'Unknown error'}
          </p>
        )}

        {data && (
          <>
            {/* The model sometimes returns a script that's the same length
                or LONGER than the current one — typically when the original
                already fits the target. Flag this so the user doesn't
                accept a non-improvement by reflex. */}
            {data.proposedWords >= data.currentWords && (
              <div
                style={{
                  padding: '10px 14px',
                  background: 'var(--warn-bg, rgba(220, 160, 0, 0.12))',
                  border: '1px solid var(--warn, #d4a017)',
                  borderRadius: 6,
                  fontSize: 12,
                  color: 'var(--fg)',
                  lineHeight: 1.5,
                }}
              >
                <strong>Heads up:</strong> the proposed script ({data.proposedWords} words) isn't shorter
                than the current one ({data.currentWords} words). This usually means the script already
                fits — the narration timing concern may be a false positive. You can still accept the
                rewrite if you prefer the new wording, or close this dialog and leave the script alone.
              </div>
            )}
            <div style={{ display: 'flex', gap: 16, fontSize: 12, color: 'var(--fg-muted)' }}>
              <span>Target: <strong style={{ color: 'var(--fg)' }}>{data.targetWords} words</strong> (~{data.targetDurationSec.toFixed(1)}s at 150 wpm)</span>
              <span>Current: <strong style={{ color: 'var(--fg)' }}>{data.currentWords} words</strong></span>
              <span>Proposed: <strong style={{ color: data.proposedWords >= data.currentWords ? 'var(--warn, #d4a017)' : 'var(--accent)' }}>{data.proposedWords} words</strong></span>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, flex: 1, minHeight: 0, overflow: 'hidden' }}>
              <ScriptColumn label="Current" body={data.currentScript} />
              <ScriptColumn label="Proposed" body={data.proposedScript} accent />
            </div>

            {saveMutation.isError && (
              <p style={{ color: 'var(--danger)', fontSize: 13 }}>
                Save failed:{' '}
                {saveMutation.error instanceof Error ? saveMutation.error.message : 'Unknown error'}
              </p>
            )}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                onClick={onClose}
                style={{
                  padding: '8px 16px',
                  background: 'transparent',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  color: 'var(--fg)',
                  cursor: 'pointer',
                  fontSize: 13,
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => tightenMutation.mutate()}
                disabled={tightenMutation.isPending}
                style={{
                  padding: '8px 16px',
                  background: 'var(--surface)',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  color: 'var(--fg)',
                  cursor: tightenMutation.isPending ? 'wait' : 'pointer',
                  fontSize: 13,
                }}
              >
                {tightenMutation.isPending ? 'Re-tightening…' : 'Try again'}
              </button>
              <button
                onClick={() => saveMutation.mutate(data.proposedScript)}
                disabled={saveMutation.isPending}
                style={{
                  padding: '8px 16px',
                  background: data.proposedWords >= data.currentWords ? 'var(--surface)' : 'var(--accent)',
                  border: data.proposedWords >= data.currentWords ? '1px solid var(--border)' : 'none',
                  borderRadius: 6,
                  color: data.proposedWords >= data.currentWords ? 'var(--fg)' : '#fff',
                  cursor: saveMutation.isPending ? 'wait' : 'pointer',
                  fontSize: 13,
                  fontWeight: 600,
                  opacity: saveMutation.isPending ? 0.7 : 1,
                }}
              >
                {saveMutation.isPending
                  ? 'Saving…'
                  : data.proposedWords >= data.currentWords
                    ? 'Accept anyway'
                    : 'Accept & save'}
              </button>
            </div>

            <p style={{ fontSize: 11, color: 'var(--fg-muted)', margin: 0 }}>
              Saving replaces the script and clears the existing TTS audio chunks — you'll need to
              regenerate narration on the Narration tab for the new wording to be spoken.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function ScriptColumn({ label, body, accent }: { label: string; body: string; accent?: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minHeight: 0 }}>
      <div style={{ fontSize: 11, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: 1 }}>{label}</div>
      <pre
        style={{
          flex: 1,
          margin: 0,
          padding: 12,
          background: 'var(--surface)',
          border: `1px solid ${accent ? 'var(--accent)' : 'var(--border)'}`,
          borderRadius: 6,
          fontSize: 13,
          lineHeight: 1.5,
          color: 'var(--fg)',
          whiteSpace: 'pre-wrap',
          fontFamily: 'inherit',
          overflow: 'auto',
        }}
      >
        {body}
      </pre>
    </div>
  );
}

export function ReviewPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const { project } = useOutletContext<WorkspaceContext>();
  const queryClient = useQueryClient();
  // When set, the tighten modal is open for this scene. null = closed.
  const [tightenSceneId, setTightenSceneId] = useState<string | null>(null);

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

  return (
    <div style={{ padding: '32px 48px', maxWidth: 900 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>Quality Review</h1>
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
      {review?.reviewedAt && Date.now() - Date.parse(review.reviewedAt) > 60_000 && (
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
              const tab = categoryToTab(item.category);
              const base = `/project/${projectId}/storyboard?scene=${encodeURIComponent(sceneId)}`;
              const target = tab ? `${base}&tab=${encodeURIComponent(tab)}` : base;
              // Narration warnings are usually "script too long for the clip".
              // The actionable fix is to tighten the script, not to tweak TTS
              // speed on the Narration tab — surface a recommend button that
              // does the right thing in one click.
              const canTighten = item.category === 'narration';
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
