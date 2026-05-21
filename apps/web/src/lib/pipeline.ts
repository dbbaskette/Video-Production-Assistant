/**
 * Pipeline step computation — shared between the Project Overview's
 * horizontal Pipeline and the persistent left-rail sidebar so both
 * surfaces tell the user the same story about workflow ordering.
 *
 * `usePipelineSteps` returns the same data the Pipeline component used
 * to compute inline, factored out so the sidebar can render a compact
 * version (number + dot + label) without duplicating the
 * done/next/todo logic.
 */

import { useQuery } from '@tanstack/react-query';
import {
  storyboardApi,
  qualityReviewApi,
  renderApi,
} from './api.js';
import { reviewSummaryLabel, type ReviewStatus } from './palette.js';

export type PipelineStepStatus = 'done' | 'next' | 'todo';

export interface PipelineStep {
  key: 'storyboard' | 'recordings' | 'script' | 'narration' | 'lower-thirds' | 'render' | 'review';
  /** Short name for the sidebar; the Pipeline component uses the same label. */
  label: string;
  to: string;
  status: PipelineStepStatus;
  /** Sub-line shown on the Project Overview pipeline (counts, status word). */
  detail?: string;
}

interface Result {
  steps: PipelineStep[];
  /** The single 'next' step, if any. */
  next?: PipelineStep;
  /** True when nothing is unchecked. */
  allDone: boolean;
}

/**
 * Reads project state and returns the canonical step list. All queries
 * are cached so calling this in two places (sidebar + overview) doesn't
 * fan out extra requests.
 */
export function usePipelineSteps(projectId: string | undefined): Result {
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
  const { data: renderStatus } = useQuery({
    queryKey: ['render-status', projectId],
    queryFn: () => renderApi.status(projectId!),
    enabled: !!projectId,
  });

  const sceneCount = storyboard?.scenes?.length ?? 0;
  const hasStoryboard = !!storyboard && sceneCount > 0;
  const recordingCount = storyboard?.scenes?.filter((s) => s.recording).length ?? 0;
  // A scene "has a script" when narration.script (or either of the legacy
  // monologue / dialog snapshots) is non-empty. Same predicate the script
  // overview page uses.
  const scriptCount = storyboard?.scenes?.filter((s) => {
    const n = s.narration;
    return !!(n?.script || n?.monologueScript || n?.dialogScript);
  }).length ?? 0;
  const narrationCount = storyboard?.scenes?.filter((s) => s.narration?.audio).length ?? 0;
  const lowerThirdCount =
    storyboard?.scenes?.filter((s) => (s.lower_thirds?.length ?? 0) > 0).length ?? 0;
  const finalRendered = !!renderStatus?.exists;

  const reviewStatus: ReviewStatus = !review?.status
    ? 'unrun'
    : review.status === 'ok'
      ? 'ready'
      : (review.status as ReviewStatus);

  type Raw = Omit<PipelineStep, 'status'> & { done: boolean };
  const raw: Raw[] = [
    {
      key: 'storyboard',
      label: 'Storyboard',
      to: `/project/${projectId}/storyboard`,
      detail: hasStoryboard ? `${sceneCount} scenes` : 'Generate or upload',
      done: hasStoryboard,
    },
    {
      key: 'recordings',
      label: 'Recordings',
      to: `/project/${projectId}/recordings`,
      detail: hasStoryboard ? `${recordingCount}/${sceneCount}` : '—',
      done: hasStoryboard && recordingCount === sceneCount,
    },
    {
      key: 'script',
      label: 'Script',
      // Project-wide script overview — same pattern as Narration / Lower
      // Thirds. Each row deep-links to the scene's Script tab.
      to: `/project/${projectId}/script`,
      // Scripts are optional — the user can ship a silent video. Pragmatic
      // done-rule mirrors narration / lower-thirds: marked done once
      // recordings are in.
      detail: scriptCount > 0 ? `${scriptCount}/${sceneCount}` : 'Optional',
      done: hasStoryboard && recordingCount === sceneCount,
    },
    {
      key: 'narration',
      label: 'Narration',
      // Cross-scene narration overview — replaces the old dead-link to
      // /storyboard. Each row deep-links into its scene's Narration tab.
      to: `/project/${projectId}/narration`,
      // Narration is OPTIONAL — the user can render with the recording's
      // original audio or render silent. Pragmatic done-rule: marked done
      // once all recordings are in.
      detail: narrationCount > 0 ? `${narrationCount}/${sceneCount}` : 'Optional',
      done: hasStoryboard && recordingCount === sceneCount,
    },
    {
      key: 'lower-thirds',
      label: 'Lower Thirds',
      to: `/project/${projectId}/lower-thirds`,
      detail: lowerThirdCount > 0 ? `${lowerThirdCount}/${sceneCount}` : 'Optional',
      // Optional — done once recordings are in.
      done: hasStoryboard && recordingCount === sceneCount,
    },
    {
      key: 'render',
      label: 'Render',
      // Dedicated page — matches the Narration / Lower Thirds pattern.
      // Previously this was a scroll-down section on the overview which
      // confused users ("nothing happened when I clicked Render").
      to: `/project/${projectId}/render`,
      detail: finalRendered ? 'Done' : 'final.mp4',
      done: finalRendered,
    },
    {
      key: 'review',
      label: 'Quality Review',
      to: `/project/${projectId}/review`,
      detail: reviewSummaryLabel(reviewStatus, {
        warnings: review?.summary.warn ?? 0,
        issues: review?.summary.issue ?? 0,
      }),
      done: reviewStatus === 'ready',
    },
  ];

  let foundNext = false;
  const steps: PipelineStep[] = raw.map((s) => {
    if (s.done) return { ...s, status: 'done' };
    if (!foundNext) {
      foundNext = true;
      return { ...s, status: 'next' };
    }
    return { ...s, status: 'todo' };
  });

  return {
    steps,
    next: steps.find((s) => s.status === 'next'),
    allDone: steps.every((s) => s.status === 'done'),
  };
}
