/**
 * Modal for the "bring your own script" flow: the user pastes a draft, this
 * modal asks the LLM to evaluate + editorially polish it (improve pacing /
 * clarity / flow, add emotive tags, fit to the recording length), and shows
 * the polished proposal next to the original with a short critique. On Accept
 * it saves the polished text as the scene's monologue script via the same
 * path the editor uses — so the previous version is backed up (restore) and
 * stale TTS chunks are cleared.
 *
 * Modeled on TightenScriptModal so the side-by-side review matches an
 * existing pattern. Difference: polish rephrases + adds emotives (Tighten
 * only removes), and it's driven by a pasted draft rather than the saved
 * script.
 */
import { useEffect } from 'react';
import { useMutation } from '@tanstack/react-query';
import { scriptApi, narrationApi } from '../lib/api.js';

export interface PolishScriptModalProps {
  projectId: string;
  sceneId: string;
  sceneName: string;
  /** The user's pasted draft to evaluate + polish. */
  draft: string;
  onClose: () => void;
  /** Fired once the polished script has been saved. Use to invalidate any
   *  cached queries the caller cares about (script, narration, storyboard). */
  onAccepted: () => void;
}

export function PolishScriptModal({
  projectId,
  sceneId,
  sceneName,
  draft,
  onClose,
  onAccepted,
}: PolishScriptModalProps) {
  const polishMutation = useMutation({
    mutationFn: () => scriptApi.polish(projectId, sceneId, { draft }),
  });
  const saveMutation = useMutation({
    // Save through the monologue slot so the previous script is backed up and
    // stale TTS chunks are cleared — identical to the editor's Save.
    mutationFn: (script: string) => narrationApi.saveScript(projectId, sceneId, script, 'monologue'),
    onSuccess: () => {
      onAccepted();
      onClose();
    },
  });

  // Kick off the polish request the first time the modal opens.
  useEffect(() => { polishMutation.mutate(); }, []);

  const data = polishMutation.data;

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
          <h2 style={{ margin: 0, fontSize: 18 }}>Evaluate &amp; polish — {sceneName}</h2>
          <button
            onClick={onClose}
            style={{ background: 'transparent', border: 'none', color: 'var(--fg-muted)', cursor: 'pointer', fontSize: 18 }}
          >
            ✕
          </button>
        </div>

        {polishMutation.isPending && (
          <p style={{ color: 'var(--fg-muted)', fontSize: 13 }}>
            Evaluating your script — polishing for delivery, adding emotive tags…
          </p>
        )}

        {polishMutation.isError && (
          <p style={{ color: 'var(--danger)', fontSize: 13 }}>
            Polish failed:{' '}
            {polishMutation.error instanceof Error ? polishMutation.error.message : 'Unknown error'}
          </p>
        )}

        {data && (
          <>
            {/* Word-count stats + fit context. When targetWords is null the
                scene has no recording, so we didn't fit to length — say so. */}
            <div style={{ display: 'flex', gap: 16, fontSize: 12, color: 'var(--fg-muted)', flexWrap: 'wrap' }}>
              {data.targetWords != null ? (
                <span>
                  Target:{' '}
                  <strong style={{ color: 'var(--fg)' }}>{data.targetWords} words</strong>
                  {data.targetDurationSec != null && ` (~${data.targetDurationSec.toFixed(1)}s at ${data.wpm} wpm)`}
                </span>
              ) : (
                <span>No recording yet — polished for quality only, not fitted to length.</span>
              )}
              <span>Yours: <strong style={{ color: 'var(--fg)' }}>{data.currentWords} words</strong></span>
              <span>Proposed: <strong style={{ color: 'var(--accent)' }}>{data.proposedWords} words</strong></span>
            </div>
            {data.targetWords != null && (
              <p style={{ fontSize: 11, color: 'var(--fg-muted)', margin: 0 }}>
                {data.wpmIsMeasured
                  ? `Rate is measured from your project's ${data.wpmSampleChunks} generated TTS chunks — not a default.`
                  : `Rate is the 150 wpm default (no narration generated yet). Once you generate TTS, this will use your engine's actual speed.`}
              </p>
            )}

            {/* Critique — the model's evaluation of the draft. Hidden when the
                model returned no notes (e.g. JSON parse fell back to raw text). */}
            {data.notes.length > 0 && (
              <div
                style={{
                  padding: '10px 14px',
                  background: 'var(--info-bg, rgba(122, 162, 247, 0.12))',
                  border: '1px solid var(--accent)',
                  borderRadius: 6,
                  fontSize: 12,
                  color: 'var(--fg)',
                  lineHeight: 1.5,
                }}
              >
                <div style={{ fontWeight: 600, marginBottom: 4 }}>What changed</div>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {data.notes.map((n, i) => (
                    <li key={i}>{n}</li>
                  ))}
                </ul>
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, flex: 1, minHeight: 0, overflow: 'hidden' }}>
              <ScriptColumn label="Your draft" body={data.originalScript} />
              <ScriptColumn label="Polished" body={data.proposedScript} accent />
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
                onClick={() => polishMutation.mutate()}
                disabled={polishMutation.isPending}
                style={{
                  padding: '8px 16px',
                  background: 'var(--surface)',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  color: 'var(--fg)',
                  cursor: polishMutation.isPending ? 'wait' : 'pointer',
                  fontSize: 13,
                }}
              >
                {polishMutation.isPending ? 'Re-polishing…' : 'Try again'}
              </button>
              <button
                onClick={() => saveMutation.mutate(data.proposedScript)}
                disabled={saveMutation.isPending}
                style={{
                  padding: '8px 16px',
                  background: 'var(--accent)',
                  border: 'none',
                  borderRadius: 6,
                  color: '#fff',
                  cursor: saveMutation.isPending ? 'wait' : 'pointer',
                  fontSize: 13,
                  fontWeight: 600,
                  opacity: saveMutation.isPending ? 0.6 : 1,
                }}
              >
                {saveMutation.isPending ? 'Saving…' : 'Accept & save'}
              </button>
            </div>

            <p style={{ fontSize: 11, color: 'var(--fg-muted)', margin: 0 }}>
              Saving replaces the monologue script and clears the existing TTS audio chunks — you'll
              need to regenerate narration on the Narration tab for the new wording to be spoken.
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
