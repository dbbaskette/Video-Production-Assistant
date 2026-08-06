import { useEffect, useId, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { PresentationJob, Scene } from '@vpa/shared';
import { presentationsApi } from '../lib/api.js';
import { presentationActions, presentationProgress, type PresentationAction } from '../lib/presentation-import-ui.js';
import { useModalFocus } from './ui/useModalFocus.js';

const POLL_INTERVAL_MS = 1_000;
const MAX_DISPLAY_NAME = 120;

export interface PresentationRemovalContext {
  presentationId: string;
  previousScenes: Scene[];
  removedSceneIds: string[];
}

export interface PresentationImportsProps {
  projectId: string;
  scenes: Scene[];
  onRemoved?(context: PresentationRemovalContext): void;
}

export function PresentationImports({ projectId, scenes, onRemoved }: PresentationImportsProps) {
  const queryClient = useQueryClient();
  const regionId = useId();
  const [open, setOpen] = useState(true);
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set());
  const pendingIdsRef = useRef(new Set<string>());
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});
  const [removal, setRemoval] = useState<{
    job: PresentationJob;
    previousScenes: Scene[];
  } | null>(null);
  const [removalPending, setRemovalPending] = useState(false);
  const removalInFlightRef = useRef(false);
  const [removalNotice, setRemovalNotice] = useState<string | null>(null);
  const previousJobsRef = useRef<Map<string, PresentationJob> | null>(null);

  const presentationsQuery = useQuery({
    queryKey: ['presentations', projectId],
    queryFn: () => presentationsApi.list(projectId),
    retry: false,
    refetchInterval: (query) => {
      const jobs = query.state.data;
      return open && jobs?.some((item) => !presentationProgress(item).terminal)
        ? POLL_INTERVAL_MS
        : false;
    },
  });

  const jobs = presentationsQuery.data ?? [];

  useEffect(() => {
    if (!presentationsQuery.data) return;
    const previous = previousJobsRef.current;
    const current = new Map(presentationsQuery.data.map((item) => [item.id, item]));
    previousJobsRef.current = current;
    if (!previous) return;

    const storyboardChanged = presentationsQuery.data.some((item) => {
      const before = previous.get(item.id);
      if (!before) return false;
      const committedNow = before.deterministic_commit !== 'committed'
        && item.deterministic_commit === 'committed';
      const narrationFinished = before.stage === 'drafting-narration'
        && !presentationProgress(before).terminal
        && presentationProgress(item).terminal;
      return committedNow || narrationFinished;
    });
    if (storyboardChanged) {
      void queryClient.invalidateQueries({ queryKey: ['storyboard', projectId] });
    }
  }, [presentationsQuery.data, projectId, queryClient]);

  const beginItemAction = (id: string): boolean => {
    if (pendingIdsRef.current.has(id)) return false;
    pendingIdsRef.current.add(id);
    setPendingIds(new Set(pendingIdsRef.current));
    setActionErrors((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
    setRemovalNotice(null);
    return true;
  };

  const finishItemAction = (id: string) => {
    pendingIdsRef.current.delete(id);
    setPendingIds(new Set(pendingIdsRef.current));
  };

  const updateJob = (next: PresentationJob) => {
    queryClient.setQueryData<PresentationJob[]>(['presentations', projectId], (current) => (
      current?.map((item) => item.id === next.id ? next : item) ?? [next]
    ));
  };

  const retry = async (job: PresentationJob, action: Extract<PresentationAction, 'retry-import' | 'retry-narration'>) => {
    if (!beginItemAction(job.id)) return;
    try {
      const next = action === 'retry-import'
        ? await presentationsApi.retryImport(projectId, job.id)
        : await presentationsApi.retryNarration(projectId, job.id);
      updateJob(next);
    } catch {
      setActionErrors((current) => ({
        ...current,
        [job.id]: action === 'retry-import'
          ? 'Import could not be retried. Refresh the presentation and try again.'
          : 'Narration could not be retried. Check the model assignments, then try again.',
      }));
    } finally {
      finishItemAction(job.id);
    }
  };

  const prepareRemoval = async (job: PresentationJob) => {
    if (removal || !beginItemAction(job.id)) return;
    try {
      const fresh = await presentationsApi.get(projectId, job.id);
      updateJob(fresh);
      if (!presentationActions(fresh).includes('remove')) {
        setActionErrors((current) => ({
          ...current,
          [job.id]: 'This presentation cannot be removed in its current state. Refresh and try again.',
        }));
        return;
      }
      setRemoval({ job: fresh, previousScenes: scenes });
    } catch {
      setActionErrors((current) => ({
        ...current,
        [job.id]: 'Removal details could not be refreshed. Try again before removing this deck.',
      }));
    } finally {
      finishItemAction(job.id);
    }
  };

  const remove = async () => {
    if (!removal || removalInFlightRef.current) return;
    removalInFlightRef.current = true;
    setRemovalPending(true);
    const { job, previousScenes } = removal;
    const removedSceneIds = previousScenes
      .filter((scene) => scene.presentation_source?.presentation_id === job.id)
      .map((scene) => scene.id);
    try {
      await presentationsApi.remove(projectId, job.id);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['presentations', projectId] }),
        queryClient.invalidateQueries({ queryKey: ['storyboard', projectId] }),
      ]);
      setRemoval(null);
      onRemoved?.({ presentationId: job.id, previousScenes, removedSceneIds });
    } catch {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['presentations', projectId] }),
        queryClient.invalidateQueries({ queryKey: ['storyboard', projectId] }),
      ]);
      setRemoval(null);
      setRemovalNotice(
        'Removal could not be confirmed. Presentation and storyboard details were refreshed; check the current scenes before trying again.',
      );
    } finally {
      removalInFlightRef.current = false;
      setRemovalPending(false);
    }
  };

  return (
    <section className="presentation-imports" aria-labelledby={`${regionId}-heading`}>
      <button
        type="button"
        className="presentation-imports__disclosure"
        aria-expanded={open}
        aria-controls={regionId}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="presentation-imports__disclosure-label">
          <span className="presentation-imports__chevron" aria-hidden>{open ? '▾' : '▸'}</span>
          <span id={`${regionId}-heading`}>Presentations</span>
        </span>
        {presentationsQuery.data && (
          <span className="presentation-imports__count">{jobs.length}</span>
        )}
      </button>

      {open && (
        <div id={regionId} className="presentation-imports__body">
          {removalNotice && (
            <p className="presentation-imports__error" role="alert">{removalNotice}</p>
          )}
          {presentationsQuery.isPending ? (
            <p className="presentation-imports__empty" aria-live="polite">Loading presentations…</p>
          ) : presentationsQuery.isError ? (
            <p className="presentation-imports__error" role="alert">
              Presentations could not be loaded. Refresh this page to try again.
            </p>
          ) : jobs.length === 0 ? (
            <p className="presentation-imports__empty">No presentation imports yet.</p>
          ) : (
            <ul className="presentation-imports__list">
              {jobs.map((job) => (
                <PresentationImportRow
                  key={job.id}
                  job={job}
                  pending={pendingIds.has(job.id)}
                  error={actionErrors[job.id]}
                  onRetry={(action) => void retry(job, action)}
                  onRemove={() => void prepareRemoval(job)}
                />
              ))}
            </ul>
          )}
        </div>
      )}

      {removal && (
        <PresentationRemovalDialog
          job={removal.job}
          pending={removalPending}
          onCancel={() => {
            if (!removalPending) setRemoval(null);
          }}
          onConfirm={() => void remove()}
        />
      )}
    </section>
  );
}

function PresentationImportRow({
  job,
  pending,
  error,
  onRetry,
  onRemove,
}: {
  job: PresentationJob;
  pending: boolean;
  error?: string;
  onRetry(action: Extract<PresentationAction, 'retry-import' | 'retry-narration'>): void;
  onRemove(): void;
}) {
  const view = presentationProgress(job);
  const actions = presentationActions(job);
  const name = boundedName(job.filename);
  return (
    <li
      className="presentation-imports__item"
      data-testid={`presentation-import-${job.id}`}
      aria-busy={pending}
    >
      <div className="presentation-imports__item-heading">
        <strong className="presentation-imports__name" title={job.filename}>{name}</strong>
        <span className={`presentation-imports__status presentation-imports__status--${view.tone}`}>
          {view.label}
        </span>
      </div>
      <p className="presentation-imports__detail">{view.detail}</p>
      <p className="presentation-imports__meta">
        <span>{pageCount(job.page_count)}</span>
        <span aria-hidden>·</span>
        <span>{remainingSceneCount(job.remaining_scene_count)}</span>
        <span aria-hidden>·</span>
        <span>Imported <time dateTime={job.created_at}>{formatImportedAt(job.created_at)}</time></span>
      </p>
      {actions.length > 0 && (
        <div className="presentation-imports__actions">
          {actions.includes('retry-import') && (
            <button type="button" disabled={pending} onClick={() => onRetry('retry-import')}>
              Retry import
            </button>
          )}
          {actions.includes('retry-narration') && (
            <button type="button" disabled={pending} onClick={() => onRetry('retry-narration')}>
              Retry narration
            </button>
          )}
          {actions.includes('remove') && (
            <button
              type="button"
              className="presentation-imports__remove"
              disabled={pending}
              onClick={onRemove}
            >
              Remove imported deck
            </button>
          )}
        </div>
      )}
      {error && <p className="presentation-imports__error" role="alert">{error}</p>}
    </li>
  );
}

function PresentationRemovalDialog({
  job,
  pending,
  onCancel,
  onConfirm,
}: {
  job: PresentationJob;
  pending: boolean;
  onCancel(): void;
  onConfirm(): void;
}) {
  const headingId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useModalFocus({
    open: true,
    dialogRef,
    initialFocusRef: cancelRef,
    escapeDisabled: pending,
    onEscape: onCancel,
  });

  return (
    <div className="dialog-overlay" onClick={() => { if (!pending) onCancel(); }}>
      <div
        ref={dialogRef}
        className="dialog presentation-imports__dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        aria-describedby={descriptionId}
        aria-busy={pending}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id={headingId}>Remove imported deck?</h2>
        <p id={descriptionId}>{removalCopy(job.remaining_scene_count)}</p>
        <p className="presentation-imports__dialog-note">
          To restore this presentation later, upload the PDF again.
        </p>
        <div className="dialog__actions">
          <button ref={cancelRef} type="button" disabled={pending} onClick={onCancel}>Cancel</button>
          <button
            type="button"
            className="btn--danger"
            disabled={pending}
            onClick={onConfirm}
          >
            Remove imported deck
          </button>
        </div>
      </div>
    </div>
  );
}

function boundedName(value: string): string {
  if (value.length <= MAX_DISPLAY_NAME) return value;
  return `${value.slice(0, MAX_DISPLAY_NAME - 1)}…`;
}

function pageCount(count: number): string {
  return `${count} ${count === 1 ? 'page' : 'pages'}`;
}

function remainingSceneCount(count: number): string {
  return `${count} ${count === 1 ? 'scene remains' : 'scenes remain'}`;
}

function removalCopy(count: number): string {
  if (count === 0) return 'No remaining scenes will be deleted. Presentation assets will be removed.';
  return `${count} remaining ${count === 1 ? 'scene' : 'scenes'} will be deleted.`;
}

function formatImportedAt(value: string): string {
  const date = new Date(value);
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}
