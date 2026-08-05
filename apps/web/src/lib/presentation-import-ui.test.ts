import type { PresentationJob } from '@vpa/shared';
import { describe, expect, it } from 'vitest';
import { presentationActions, presentationProgress } from './presentation-import-ui.js';

const baseJob: PresentationJob = {
  schema_version: 1,
  id: '22222222-2222-4222-8222-222222222222',
  project_id: '11111111-1111-4111-8111-111111111111',
  filename: 'private-name.pdf',
  status: 'processing',
  stage: 'uploading',
  generate_narration: true,
  page_count: 0,
  processed_pages: 0,
  analyzed_pages: 0,
  scripted_pages: 0,
  remaining_scene_count: 0,
  deterministic_commit: 'uncommitted',
  created_at: '2026-08-05T12:00:00.000Z',
  updated_at: '2026-08-05T12:00:01.000Z',
};

function job(overrides: Partial<PresentationJob>): PresentationJob {
  return { ...baseJob, ...overrides };
}

describe('presentationProgress', () => {
  it('reports bounded narration counters', () => {
    expect(presentationProgress(job({
      stage: 'drafting-narration',
      page_count: 5,
      processed_pages: 5,
      analyzed_pages: 4,
      scripted_pages: 2,
      deterministic_commit: 'committed',
    }))).toEqual({
      label: 'Drafting narration',
      detail: '2 of 5 scripts ready',
      terminal: false,
      tone: 'working',
    });
  });

  it.each([
    ['uploading before page inspection', job({}), {
      label: 'Uploading', detail: 'Preparing presentation', terminal: false, tone: 'working',
    }],
    ['processing zero known pages', job({ stage: 'processing-slides' }), {
      label: 'Processing slides', detail: 'Preparing slides', terminal: false, tone: 'working',
    }],
    ['processing bounded pages', job({ stage: 'processing-slides', page_count: 200, processed_pages: 199 }), {
      label: 'Processing slides', detail: '199 of 200 slides processed', terminal: false, tone: 'working',
    }],
    ['creating scenes', job({ stage: 'creating-scenes', page_count: 4, processed_pages: 3 }), {
      label: 'Creating scenes', detail: '3 of 4 slides ready', terminal: false, tone: 'working',
    }],
    ['narration before counters', job({ stage: 'drafting-narration', deterministic_commit: 'committed' }), {
      label: 'Drafting narration', detail: 'Preparing narration', terminal: false, tone: 'working',
    }],
    ['committed deterministic job', job({
      status: 'ready', stage: 'ready', page_count: 5, processed_pages: 5,
      deterministic_commit: 'committed',
    }), {
      label: 'Presentation ready', detail: '5 slides imported', terminal: true, tone: 'success',
    }],
    ['ready empty count', job({ status: 'ready', stage: 'ready', deterministic_commit: 'committed' }), {
      label: 'Presentation ready', detail: 'Slides imported', terminal: true, tone: 'success',
    }],
    ['partial narration', job({
      status: 'partial', stage: 'drafting-narration', page_count: 5, processed_pages: 5,
      scripted_pages: 2, deterministic_commit: 'committed',
    }), {
      label: 'Slides ready', detail: 'Narration needs attention', terminal: true, tone: 'warning',
    }],
    ['failed import', job({
      status: 'failed', stage: 'failed', error: { code: 'processing_failed', message: '/private/path' },
    }), {
      label: 'Import failed', detail: 'The presentation could not be processed; try the import again', terminal: true, tone: 'error',
    }],
    ['failed routing', job({
      status: 'failed', stage: 'failed', deterministic_commit: 'committed',
      error: { code: 'narration_model_routing_failed', message: 'private model detail' },
    }), {
      label: 'Narration needs attention', detail: 'Choose compatible narration models and try again', terminal: true, tone: 'warning',
    }],
    ['failed narration fallback', job({
      status: 'failed', stage: 'failed', deterministic_commit: 'committed',
      error: { code: 'private_provider_failure', message: 'raw response' },
    }), {
      label: 'Narration needs attention', detail: 'Slides are ready, but narration could not be completed', terminal: true, tone: 'warning',
    }],
    ['deletion tombstone', job({ deletion_pending: true, deterministic_commit: 'committed' }), {
      label: 'Removing presentation', detail: 'Cleaning up imported slides', terminal: false, tone: 'working',
    }],
  ] as const)('%s', (_name, input, expected) => {
    expect(presentationProgress(input)).toEqual(expected);
  });

  it('never includes raw job error text or filenames', () => {
    const input = job({
      filename: '/Users/person/top-secret.pdf',
      status: 'failed',
      stage: 'failed',
      error: { code: 'unknown', message: '/Users/person/top-secret.pdf failed with provider payload' },
    });

    const progress = presentationProgress(input);

    expect(`${progress.label} ${progress.detail}`).not.toContain('top-secret');
    expect(`${progress.label} ${progress.detail}`).not.toContain('provider payload');
  });

  it.each([
    ['encrypted_pdf', 'Use an unlocked PDF and upload it again'],
    ['invalid_pdf', 'Choose a valid PDF and upload it again'],
    ['page_limit_exceeded', 'Choose a PDF with 200 slides or fewer'],
    ['source_not_available', 'Upload the original PDF again to retry'],
    ['processing_failed', 'The presentation could not be processed; try the import again'],
    ['storyboard_commit_failed', 'Slides could not be added; try the import again'],
    ['invalid_import_state', 'The import could not resume safely; try the import again'],
    ['interrupted_import', 'The import was interrupted; try the import again'],
    ['invalid_source', 'Upload the PDF again to start a new import'],
    ['committed_state_pending', 'Slides may already be saved; refresh to check the import status'],
  ] as const)('maps stable import failure %s to actionable bounded copy', (code, detail) => {
    const progress = presentationProgress(job({
      status: 'failed',
      stage: 'failed',
      deterministic_commit: code === 'storyboard_commit_failed' || code === 'committed_state_pending'
        ? 'commit-pending'
        : 'uncommitted',
      error: { code, message: '/private/raw/error must stay hidden' },
    }));

    expect(progress).toMatchObject({ label: 'Import failed', detail, terminal: true, tone: 'error' });
    expect(progress.detail).not.toContain('/private');
  });
});

describe('presentationActions', () => {
  it('offers only retry-import and remove for a retryable failed import', () => {
    expect(presentationActions(job({
      status: 'failed',
      stage: 'failed',
      deterministic_commit: 'uncommitted',
      error: { code: 'processing_failed', message: 'Presentation processing failed' },
    }))).toEqual(['retry-import', 'remove']);
  });

  it('offers only retry-narration and remove for partial narration', () => {
    expect(presentationActions(job({
      status: 'partial',
      stage: 'drafting-narration',
      deterministic_commit: 'committed',
    }))).toEqual(['retry-narration', 'remove']);
  });

  it.each([
    ['active uncommitted import', job({ stage: 'processing-slides' }), []],
    ['committed narration work', job({ stage: 'drafting-narration', deterministic_commit: 'committed' }), ['remove']],
    ['ready committed import', job({ status: 'ready', stage: 'ready', deterministic_commit: 'committed' }), ['remove']],
    ['failed import without source', job({
      status: 'failed', stage: 'failed', deterministic_commit: 'uncommitted',
      error: { code: 'source_not_available', message: 'No source' },
    }), ['remove']],
    ['commit-pending failure', job({
      status: 'failed', stage: 'failed', deterministic_commit: 'commit-pending',
      error: { code: 'storyboard_commit_failed', message: 'Unknown commit' },
    }), ['retry-import', 'remove']],
    ['failed narration routing', job({
      status: 'failed', stage: 'failed', deterministic_commit: 'committed',
      error: { code: 'narration_model_routing_failed', message: 'Routing failed' },
    }), ['retry-narration', 'remove']],
    ['failed committed import without narration request', job({
      status: 'failed', stage: 'failed', deterministic_commit: 'committed', generate_narration: false,
      error: { code: 'processing_failed', message: 'Failed' },
    }), ['remove']],
    ['deletion tombstone', job({
      status: 'failed', stage: 'failed', deterministic_commit: 'uncommitted', deletion_pending: true,
      error: { code: 'processing_failed', message: 'Failed' },
    }), []],
  ] as const)('%s', (_name, input, expected) => {
    expect(presentationActions(input)).toEqual(expected);
  });

  it.each([
    ['encrypted_pdf', 'uncommitted', ['remove']],
    ['invalid_pdf', 'uncommitted', ['remove']],
    ['page_limit_exceeded', 'uncommitted', ['remove']],
    ['source_not_available', 'uncommitted', ['remove']],
    ['invalid_source', 'uncommitted', ['remove']],
    ['committed_state_pending', 'commit-pending', ['remove']],
    ['processing_failed', 'uncommitted', ['retry-import', 'remove']],
    ['storyboard_commit_failed', 'commit-pending', ['retry-import', 'remove']],
    ['invalid_import_state', 'uncommitted', ['retry-import', 'remove']],
    ['interrupted_import', 'uncommitted', ['retry-import', 'remove']],
    ['unknown_import_failure', 'uncommitted', ['remove']],
  ] as const)('classifies stable/unknown import failure %s conservatively', (code, deterministicCommit, expected) => {
    expect(presentationActions(job({
      status: 'failed',
      stage: 'failed',
      deterministic_commit: deterministicCommit,
      error: { code, message: 'Private failure' },
    }))).toEqual(expected);
  });

  it('does not retry a failed import with no stable error code', () => {
    expect(presentationActions(job({
      status: 'failed',
      stage: 'failed',
      deterministic_commit: 'uncommitted',
      error: undefined,
    }))).toEqual(['remove']);
  });
});
