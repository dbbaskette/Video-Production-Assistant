import { useEffect, useId, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { PresentationJob, Storyboard } from '@vpa/shared';
import { presentationsApi } from '../lib/api.js';
import { presentationProgress } from '../lib/presentation-import-ui.js';
import { invalidatePresentationSceneQueries } from '../lib/presentation-query-refresh.js';

export interface PresentationProgressProps {
  projectId: string;
  initialJob: PresentationJob;
  onClose(): void;
  onTerminal?(job: PresentationJob): void;
}

export function PresentationProgress({
  projectId,
  initialJob,
  onClose,
  onTerminal,
}: PresentationProgressProps) {
  const headingId = useId();
  const queryClient = useQueryClient();
  const [job, setJob] = useState(initialJob);
  const [pollError, setPollError] = useState(false);
  const [closed, setClosed] = useState(false);
  const invalidatedRef = useRef(false);
  const terminalNotifiedRef = useRef(false);
  const jobIdRef = useRef(initialJob.id);
  const observedNonterminalRef = useRef(!presentationProgress(initialJob).terminal);
  const view = presentationProgress(job);

  useEffect(() => {
    if (jobIdRef.current !== initialJob.id) {
      jobIdRef.current = initialJob.id;
      invalidatedRef.current = false;
      terminalNotifiedRef.current = false;
      observedNonterminalRef.current = !presentationProgress(initialJob).terminal;
      setClosed(false);
    } else if (!presentationProgress(initialJob).terminal) {
      observedNonterminalRef.current = true;
    }
    setJob((current) => (
      current.id !== initialJob.id || initialJob.updated_at >= current.updated_at
        ? initialJob
        : current
    ));
    setPollError(false);
  }, [initialJob]);

  useEffect(() => {
    if (closed || view.terminal) return;
    let mounted = true;
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const next = await presentationsApi.get(projectId, job.id);
        if (!mounted) return;
        setJob(next);
        setPollError(false);
      } catch {
        if (mounted) setPollError(true);
      } finally {
        polling = false;
      }
    };
    const timer = window.setInterval(() => void poll(), 1000);
    return () => {
      mounted = false;
      window.clearInterval(timer);
    };
  }, [closed, job.id, projectId, view.terminal]);

  useEffect(() => {
    const imported = job.status === 'ready' || job.status === 'partial';
    if (!imported || invalidatedRef.current || !observedNonterminalRef.current) return;
    invalidatedRef.current = true;
    void (async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['storyboard', projectId] }),
        queryClient.invalidateQueries({ queryKey: ['presentations', projectId] }),
      ]);
      const storyboard = queryClient.getQueryData<Storyboard | null>([
        'storyboard',
        projectId,
      ]);
      await invalidatePresentationSceneQueries(
        queryClient,
        projectId,
        job.id,
        storyboard?.scenes ?? [],
      );
    })();
  }, [job.id, job.status, projectId, queryClient]);

  useEffect(() => {
    if (!view.terminal || terminalNotifiedRef.current) return;
    terminalNotifiedRef.current = true;
    onTerminal?.(job);
  }, [job, onTerminal, view.terminal]);

  if (closed) return null;

  return (
    <section
      className={`presentation-progress presentation-progress--${view.tone}`}
      aria-labelledby={headingId}
    >
      <div className="presentation-progress__heading-row">
        <div aria-live="polite" aria-atomic="true">
          <h3 id={headingId}>{view.label}</h3>
          <p>{view.detail}</p>
        </div>
        <button
          type="button"
          className="presentation-progress__close"
          aria-label="Close presentation progress"
          onClick={() => {
            setClosed(true);
            onClose();
          }}
        >
          ×
        </button>
      </div>
      <div className="presentation-progress__track" aria-hidden="true">
        <span style={{ width: `${progressPercent(job)}%` }} />
      </div>
      {pollError && (
        <p className="presentation-progress__error" role="alert">
          Progress could not be refreshed. Check this presentation again in a moment.
        </p>
      )}
      {!view.terminal && (
        <p className="presentation-progress__aside">You can close this update while slides continue processing.</p>
      )}
    </section>
  );
}

function progressPercent(job: PresentationJob): number {
  if (job.status === 'ready' || job.status === 'partial') return 100;
  if (job.page_count === 0) return 12;
  const completed = job.stage === 'drafting-narration' ? job.scripted_pages : job.processed_pages;
  return Math.max(12, Math.min(96, Math.round((completed / job.page_count) * 100)));
}
