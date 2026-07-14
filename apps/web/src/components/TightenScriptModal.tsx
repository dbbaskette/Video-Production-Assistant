/**
 * Modal that asks the LLM to tighten a scene's script to fit its recording,
 * shows the proposal next to the current script, and on Accept saves the
 * new script via PUT.
 *
 * Two entry points use it:
 *   - Quality Review → narration warnings (auto-flagged scenes)
 *   - The Script tab on a Scene page (manual trigger from the editor)
 *
 * Both pass the same scene id + a callback to invalidate caches after
 * accept. The modal is otherwise self-contained — it owns the tighten +
 * save mutations and the side-by-side diff UI.
 */
import { useEffect } from 'react';
import { useMutation } from '@tanstack/react-query';
import { scriptApi } from '../lib/api.js';

export interface TightenScriptModalProps {
  projectId: string;
  sceneId: string;
  sceneName: string;
  onClose: () => void;
  /** Fired once the new script has been saved, with the saved script text.
   *  Callers that show the script in an editor should set their edit buffer
   *  directly from this text (see ScenePage) — nulling the buffer and relying
   *  on an async query invalidation races the editor's re-hydration effect and
   *  leaves it showing the pre-tighten script. Callers that only need to
   *  refresh caches (Quality Review) can ignore the argument. */
  onAccepted: (savedScript: string) => void;
}

export function TightenScriptModal({ projectId, sceneId, sceneName, onClose, onAccepted }: TightenScriptModalProps) {
  const tightenMutation = useMutation({
    mutationFn: () => scriptApi.tighten(projectId, sceneId),
  });
  const saveMutation = useMutation({
    mutationFn: (script: string) => scriptApi.save(projectId, sceneId, script),
    onSuccess: (_data, script) => {
      onAccepted(script);
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
            {data.reason === 'already_fits' && (
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
                <strong>No tightening needed.</strong> The script ({data.currentWords} words) is
                already at or under the target ({data.targetWords} words for {data.targetDurationSec.toFixed(1)}s
                at {data.wpm} wpm). Close this dialog and leave the script alone.
              </div>
            )}
            {data.reason === 'no_safe_cut' && (
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
                <strong>Couldn't find a safe cut.</strong> The model couldn't shorten this script
                without dropping facts (target was {data.targetWords} words, current is {data.currentWords}).
                You can <em>Try again</em> to re-roll, or close this dialog and tighten by hand.
              </div>
            )}
            <div style={{ display: 'flex', gap: 16, fontSize: 12, color: 'var(--fg-muted)', flexWrap: 'wrap' }}>
              <span>Target: <strong style={{ color: 'var(--fg)' }}>{data.targetWords} words</strong> (~{data.targetDurationSec.toFixed(1)}s at {data.wpm} wpm)</span>
              <span>Current: <strong style={{ color: 'var(--fg)' }}>{data.currentWords} words</strong></span>
              <span>Proposed: <strong style={{ color: data.reason ? 'var(--fg-muted)' : 'var(--accent)' }}>{data.proposedWords} words</strong></span>
            </div>
            <p style={{ fontSize: 11, color: 'var(--fg-muted)', margin: 0 }}>
              {data.wpmIsMeasured
                ? `Rate is measured from your project's ${data.wpmSampleChunks} generated TTS chunks — not a default.`
                : `Rate is the 150 wpm default (no narration generated yet). Once you generate TTS, this will use your engine's actual speed.`}
            </p>

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
                disabled={saveMutation.isPending || !!data.reason}
                style={{
                  padding: '8px 16px',
                  background: data.reason ? 'var(--surface)' : 'var(--accent)',
                  border: data.reason ? '1px solid var(--border)' : 'none',
                  borderRadius: 6,
                  color: data.reason ? 'var(--fg-muted)' : '#fff',
                  cursor: saveMutation.isPending ? 'wait' : data.reason ? 'not-allowed' : 'pointer',
                  fontSize: 13,
                  fontWeight: 600,
                  opacity: saveMutation.isPending || data.reason ? 0.6 : 1,
                }}
              >
                {saveMutation.isPending
                  ? 'Saving…'
                  : data.reason
                    ? 'Nothing to save'
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
