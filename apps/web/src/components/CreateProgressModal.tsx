/**
 * Progress modal shown while a new project is being created *with* reference
 * docs attached. It replaces the old silent "Creating…" button — the actual
 * complaint was that doc extraction happened invisibly, so this surfaces each
 * step: project created → docs uploaded → per-doc extraction.
 *
 * Extraction runs in the background on the server; the parent polls the
 * source-docs list and feeds the latest `docs` here. The user can wait for
 * everything to finish, or hit "Continue in background" to jump into the
 * project while extraction keeps going (the source-docs list there shows the
 * same status pills).
 *
 * Purely presentational — all orchestration lives in NewProjectDialog.
 */

import type { SourceDoc } from '../lib/api.js';

export type CreateStage = 'creating' | 'uploading' | 'extracting' | 'done' | 'error';

interface Props {
  stage: CreateStage;
  totalDocs: number;
  docs: SourceDoc[];
  error?: string;
  /** Navigate into the project now, leaving extraction running. */
  onContinueBackground: () => void;
  /** Dismiss (error path — the project still exists, docs can be re-added). */
  onClose: () => void;
}

function StepIcon({ state }: { state: 'done' | 'active' | 'pending' | 'failed' }) {
  const color =
    state === 'done'
      ? 'var(--success, #3fb950)'
      : state === 'failed'
        ? 'var(--danger)'
        : state === 'active'
          ? 'var(--accent)'
          : 'var(--fg-dim)';
  const glyph = state === 'done' ? '✓' : state === 'failed' ? '✗' : state === 'active' ? '⠿' : '○';
  return (
    <span
      aria-hidden
      style={{ width: 18, display: 'inline-flex', justifyContent: 'center', color, fontSize: 13 }}
    >
      {glyph}
    </span>
  );
}

function Step({
  state,
  label,
  detail,
}: {
  state: 'done' | 'active' | 'pending' | 'failed';
  label: string;
  detail?: string;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <StepIcon state={state} />
      <span
        style={{
          fontSize: 13,
          color: state === 'pending' ? 'var(--fg-dim)' : 'var(--fg)',
          fontWeight: state === 'active' ? 600 : 400,
        }}
      >
        {label}
      </span>
      {detail && <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{detail}</span>}
    </div>
  );
}

export function CreateProgressModal({
  stage,
  totalDocs,
  docs,
  error,
  onContinueBackground,
  onClose,
}: Props) {
  const created = stage !== 'creating';
  const uploaded = stage === 'extracting' || stage === 'done';
  const extractedCount = docs.filter((d) => d.status && d.status !== 'extracting').length;
  const readyCount = docs.filter((d) => d.status === 'ready').length;
  const failedCount = docs.filter((d) => d.status === 'failed').length;
  const allDone = stage === 'done' || (uploaded && extractedCount >= docs.length && docs.length > 0);

  return (
    <div
      className="dialog-overlay"
      role="dialog"
      aria-modal="true"
      style={{ zIndex: 1100 }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="dialog" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 460 }}>
        <h2 style={{ margin: '0 0 4px', fontSize: 18 }}>
          {stage === 'error' ? 'Something went wrong' : allDone ? 'Project ready' : 'Setting up your project'}
        </h2>
        <p style={{ margin: '0 0 16px', fontSize: 13, color: 'var(--fg-muted)', lineHeight: 1.5 }}>
          {stage === 'error'
            ? `The project was created, but the reference docs didn’t upload${error ? ` (${error})` : ''}. You can add them later from Project Overview.`
            : 'Reference docs are read in the background — you don’t have to wait for them.'}
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 18 }}>
          <Step state={created ? 'done' : 'active'} label="Create project" />
          <Step
            state={uploaded ? 'done' : created ? 'active' : 'pending'}
            label={`Upload ${totalDocs} reference doc${totalDocs === 1 ? '' : 's'}`}
          />
          <Step
            state={
              stage === 'error'
                ? 'failed'
                : allDone
                  ? failedCount > 0
                    ? 'failed'
                    : 'done'
                  : uploaded
                    ? 'active'
                    : 'pending'
            }
            label="Extract document text"
            detail={
              uploaded && !allDone
                ? `${extractedCount}/${docs.length}…`
                : allDone
                  ? `${readyCount} ready${failedCount > 0 ? `, ${failedCount} failed` : ''}`
                  : undefined
            }
          />
        </div>

        {/* Per-doc rows once extraction is underway. */}
        {uploaded && docs.length > 0 && (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              marginBottom: 18,
              maxHeight: 160,
              overflowY: 'auto',
            }}
          >
            {docs.map((d) => (
              <div
                key={d.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  fontSize: 12,
                  color: 'var(--fg-muted)',
                }}
              >
                <StepIcon
                  state={
                    d.status === 'ready' ? 'done' : d.status === 'failed' ? 'failed' : 'active'
                  }
                />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {d.name}
                </span>
              </div>
            ))}
          </div>
        )}

        <div className="dialog__actions">
          {stage === 'error' ? (
            <>
              <button onClick={onClose}>Close</button>
              <button className="primary" onClick={onContinueBackground}>
                Open project anyway
              </button>
            </>
          ) : allDone ? (
            <button className="primary" onClick={onContinueBackground}>
              Open project
            </button>
          ) : (
            <button onClick={onContinueBackground} disabled={!created}>
              Continue in background →
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
