import type { PresentationJob } from '@vpa/shared';

export type PresentationAction = 'retry-import' | 'retry-narration' | 'remove';
export type PresentationTone = 'working' | 'success' | 'warning' | 'error';

export interface PresentationProgressViewModel {
  label: string;
  detail: string;
  terminal: boolean;
  tone: PresentationTone;
}

const working = (
  label: string,
  detail: string,
): PresentationProgressViewModel => ({ label, detail, terminal: false, tone: 'working' });

function boundedCounterDetail(
  completed: number,
  total: number,
  noun: string,
  emptyDetail: string,
): string {
  if (total === 0) return emptyDetail;
  return `${completed} of ${total} ${noun}`;
}

function processingProgress(job: PresentationJob): PresentationProgressViewModel {
  const stage = job.stage;
  switch (stage) {
    case 'uploading':
      return working('Uploading', 'Preparing presentation');
    case 'processing-slides':
      return working(
        'Processing slides',
        boundedCounterDetail(job.processed_pages, job.page_count, 'slides processed', 'Preparing slides'),
      );
    case 'creating-scenes':
      return working(
        'Creating scenes',
        boundedCounterDetail(job.processed_pages, job.page_count, 'slides ready', 'Preparing scenes'),
      );
    case 'drafting-narration':
      return working(
        'Drafting narration',
        boundedCounterDetail(job.scripted_pages, job.page_count, 'scripts ready', 'Preparing narration'),
      );
    case 'ready':
      return working('Finishing presentation', 'Preparing imported slides');
    case 'failed':
      return working('Finishing presentation', 'Checking import status');
    default:
      return assertNever(stage);
  }
}

function importedDetail(pageCount: number): string {
  return pageCount === 0 ? 'Slides imported' : `${pageCount} slides imported`;
}

function stableFailureDetail(job: PresentationJob): string {
  switch (job.error?.code) {
    case 'narration_model_routing_failed':
      return 'Choose compatible narration models and try again';
    case 'narration_operational_failure':
    case 'narration_failed':
      return 'Slides are ready, but narration could not be completed';
    case 'source_not_available':
      return 'The original PDF is no longer available';
    case 'storyboard_commit_failed':
      return 'Slides could not be added to the storyboard';
    default:
      return job.deterministic_commit === 'committed'
        ? 'Slides are ready, but narration could not be completed'
        : 'The presentation could not be imported';
  }
}

export function presentationProgress(job: PresentationJob): PresentationProgressViewModel {
  if (job.deletion_pending) {
    return working('Removing presentation', 'Cleaning up imported slides');
  }

  const status = job.status;
  switch (status) {
    case 'processing':
      return processingProgress(job);
    case 'ready':
      return {
        label: 'Presentation ready',
        detail: importedDetail(job.page_count),
        terminal: true,
        tone: 'success',
      };
    case 'partial':
      return {
        label: 'Slides ready',
        detail: 'Narration needs attention',
        terminal: true,
        tone: 'warning',
      };
    case 'failed': {
      const narrationFailure = job.deterministic_commit === 'committed';
      return {
        label: narrationFailure ? 'Narration needs attention' : 'Import failed',
        detail: stableFailureDetail(job),
        terminal: true,
        tone: narrationFailure ? 'warning' : 'error',
      };
    }
    default:
      return assertNever(status);
  }
}

export function presentationActions(job: PresentationJob): PresentationAction[] {
  if (job.deletion_pending) return [];
  const actions: PresentationAction[] = [];
  const narrationRetry = job.generate_narration
    && job.deterministic_commit === 'committed'
    && (job.status === 'partial' || job.status === 'failed');
  const importRetry = job.status === 'failed'
    && job.deterministic_commit === 'uncommitted'
    && job.error?.code !== 'source_not_available';

  if (importRetry) actions.push('retry-import');
  if (narrationRetry) actions.push('retry-narration');
  if (job.deterministic_commit === 'committed' || job.status === 'failed') actions.push('remove');
  return actions;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled presentation state: ${String(value)}`);
}
