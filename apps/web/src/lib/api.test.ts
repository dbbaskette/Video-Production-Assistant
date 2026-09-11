import type { PresentationJob } from '@vpa/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { presentationsApi } from './api.js';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const PRESENTATION_ID = '22222222-2222-4222-8222-222222222222';

function job(overrides: Partial<PresentationJob> = {}): PresentationJob {
  return {
    schema_version: 1,
    id: PRESENTATION_ID,
    project_id: PROJECT_ID,
    filename: 'quarterly.pdf',
    status: 'processing',
    stage: 'processing-slides',
    generate_narration: true,
    page_count: 5,
    processed_pages: 2,
    analyzed_pages: 0,
    scripted_pages: 0,
    remaining_scene_count: 0,
    deterministic_commit: 'uncommitted',
    created_at: '2026-08-05T12:00:00.000Z',
    updated_at: '2026-08-05T12:00:01.000Z',
    ...overrides,
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Uploads go through XMLHttpRequest (fetch can't report upload progress), so
 * the presentation-upload tests stub a minimal XHR instead of fetch.
 */
class FakeXhr {
  static instances: FakeXhr[] = [];
  open = vi.fn();
  send = vi.fn();
  setRequestHeader = vi.fn();
  timeout = 0;
  responseType = '';
  response = '';
  status = 0;
  upload = { onprogress: null as ((e: ProgressEvent) => void) | null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;

  constructor() {
    FakeXhr.instances.push(this);
  }

  respond(status: number, body: unknown): void {
    this.status = status;
    this.response = body === undefined ? '' : JSON.stringify(body);
    this.onload?.();
  }
}

describe('presentationsApi', () => {
  const fetchMock = vi.fn<[RequestInfo | URL, RequestInit?], Promise<Response>>();

  beforeEach(() => {
    FakeXhr.instances = [];
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('uploads exact multipart fields over XHR without overriding headers', async () => {
    const file = new File(['%PDF'], 'quarterly.pdf', { type: 'application/pdf' });

    const pending = presentationsApi.upload(PROJECT_ID, file, true);
    const xhr = FakeXhr.instances[0]!;
    expect(xhr.open).toHaveBeenCalledWith('POST', `http://localhost:3000/api/projects/${PROJECT_ID}/presentations`);
    xhr.respond(202, { presentation_id: PRESENTATION_ID, job: job() });

    await expect(pending).resolves.toEqual(job());
    expect(xhr.send.mock.calls[0]![0]).toBeInstanceOf(FormData);
    const form = xhr.send.mock.calls[0]![0] as FormData;
    expect(form.get('file')).toBe(file);
    expect(form.get('generate_narration')).toBe('true');
    // XHR derives the multipart Content-Type itself; the client must not set one.
    expect(xhr.setRequestHeader).not.toHaveBeenCalled();
  });

  it('surfaces upload progress fractions from the XHR upload stream', async () => {
    const onProgress = vi.fn();
    const pending = presentationsApi.upload(
      PROJECT_ID,
      new File(['%PDF'], 'deck.pdf'),
      false,
      { onProgress },
    );
    const xhr = FakeXhr.instances[0]!;
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 250, total: 1000 } as ProgressEvent);
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 1000, total: 1000 } as ProgressEvent);
    xhr.respond(202, { presentation_id: PRESENTATION_ID, job: job() });

    await pending;
    expect(onProgress).toHaveBeenCalledWith({ fraction: 0.25, loaded: 250, total: 1000 });
    expect(onProgress).toHaveBeenLastCalledWith({ fraction: 1, loaded: 1000, total: 1000 });
  });

  it('rejects with request_timeout when the upload exceeds the five-minute XHR timeout', async () => {
    const pending = presentationsApi.upload(PROJECT_ID, new File(['x'], 'deck.pdf'), false);
    const xhr = FakeXhr.instances[0]!;
    expect(xhr.timeout).toBe(300_000);
    xhr.ontimeout?.();

    await expect(pending).rejects.toMatchObject({
      name: 'ApiError',
      message: 'Presentation upload timed out',
      code: 'request_timeout',
    });
  });

  it('encodes every identifier once and emits the fixed request shapes', async () => {
    const encodedProject = 'project%2F%252F';
    const encodedPresentation = 'deck%2Fone';
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ presentations: [] }))
      .mockResolvedValueOnce(jsonResponse(job()))
      .mockResolvedValueOnce(jsonResponse(job()))
      .mockResolvedValueOnce(jsonResponse(job()))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await presentationsApi.list('project/%2F');
    await presentationsApi.get('project/%2F', 'deck/one').catch(() => undefined);
    await presentationsApi.retryImport('project/%2F', 'deck/one').catch(() => undefined);
    await presentationsApi.retryNarration('project/%2F', 'deck/one').catch(() => undefined);
    await presentationsApi.remove('project/%2F', 'deck/one');

    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      [`http://localhost:3000/api/projects/${encodedProject}/presentations`, 'GET'],
      [`http://localhost:3000/api/projects/${encodedProject}/presentations/${encodedPresentation}`, 'GET'],
      [`http://localhost:3000/api/projects/${encodedProject}/presentations/${encodedPresentation}/retry-import`, 'POST'],
      [`http://localhost:3000/api/projects/${encodedProject}/presentations/${encodedPresentation}/retry-narration`, 'POST'],
      [`http://localhost:3000/api/projects/${encodedProject}/presentations/${encodedPresentation}?confirmed=true`, 'DELETE'],
    ]);
  });

  it('maps server errors, network failures, and non-JSON bodies to ApiError', async () => {
    const serverError = presentationsApi.upload(PROJECT_ID, new File(['x'], 'deck.pdf'), false);
    FakeXhr.instances[0]!.respond(409, { error: 'Deck already exists', code: 'conflict' });
    await expect(serverError).rejects.toMatchObject({
      name: 'ApiError',
      status: 409,
      message: 'Deck already exists',
    });

    const genericError = presentationsApi.upload(PROJECT_ID, new File(['x'], 'deck.pdf'), false);
    FakeXhr.instances[1]!.respond(500, 'Internal Server Error');
    await expect(genericError).rejects.toMatchObject({
      name: 'ApiError',
      status: 500,
      message: 'Upload failed: 500',
    });

    const networkError = presentationsApi.upload(PROJECT_ID, new File(['x'], 'deck.pdf'), false);
    FakeXhr.instances[2]!.onerror?.();
    await expect(networkError).rejects.toMatchObject({
      name: 'ApiError',
      status: 0,
      code: 'network_error',
    });
  });

  it('rejects malformed successful wrappers and direct jobs', async () => {
    const uploadPending = presentationsApi.upload(PROJECT_ID, new File(['x'], 'deck.pdf'), true);
    FakeXhr.instances[0]!.respond(202, { presentation_id: PRESENTATION_ID, job: job(), extra: true });
    await expect(uploadPending).rejects.toMatchObject({ name: 'ApiError', code: 'invalid_response' });

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ presentations: [job()], extra: true }))
      .mockResolvedValueOnce(jsonResponse({ ...job(), filename: '' }));

    await expect(presentationsApi.list(PROJECT_ID))
      .rejects.toMatchObject({ name: 'ApiError', code: 'invalid_response' });
    await expect(presentationsApi.get(PROJECT_ID, PRESENTATION_ID))
      .rejects.toMatchObject({ name: 'ApiError', code: 'invalid_response' });
  });

  it('rejects well-formed jobs that do not belong to the requested resource', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ presentations: [job({ project_id: '33333333-3333-4333-8333-333333333333' })] }))
      .mockResolvedValueOnce(jsonResponse(job({ id: '33333333-3333-4333-8333-333333333333' })))
      .mockResolvedValueOnce(jsonResponse(job({ project_id: '33333333-3333-4333-8333-333333333333' })));

    await expect(presentationsApi.list(PROJECT_ID))
      .rejects.toMatchObject({ name: 'ApiError', code: 'invalid_response' });
    await expect(presentationsApi.get(PROJECT_ID, PRESENTATION_ID))
      .rejects.toMatchObject({ name: 'ApiError', code: 'invalid_response' });
    await expect(presentationsApi.retryNarration(PROJECT_ID, PRESENTATION_ID))
      .rejects.toMatchObject({ name: 'ApiError', code: 'invalid_response' });
  });

  it('propagates only bounded server errors', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: 'Try again', code: 'processing_failed' }, 409))
      .mockResolvedValueOnce(jsonResponse({ error: 'secret/'.repeat(100), code: 'x'.repeat(200) }, 400));

    await expect(presentationsApi.retryImport(PROJECT_ID, PRESENTATION_ID)).rejects.toMatchObject({
      name: 'ApiError',
      status: 409,
      message: 'Try again',
      code: 'processing_failed',
      payload: { error: 'Try again', code: 'processing_failed' },
    });
    await expect(presentationsApi.retryImport(PROJECT_ID, PRESENTATION_ID)).rejects.toMatchObject({
      name: 'ApiError',
      status: 400,
      message: 'HTTP 400',
      code: 'http_error',
      payload: null,
    });
  });

  it('requires an empty 204 response for removal', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    await expect(presentationsApi.remove(PROJECT_ID, PRESENTATION_ID)).resolves.toBeUndefined();
    await expect(presentationsApi.remove(PROJECT_ID, PRESENTATION_ID)).rejects.toMatchObject({
      name: 'ApiError',
      code: 'invalid_response',
    });
  });

  it('rejects blank identifiers and unsafe image page numbers before fetching', async () => {
    await expect(presentationsApi.list('  ')).rejects.toThrow('Project ID is required');
    await expect(presentationsApi.get(PROJECT_ID, '')).rejects.toThrow('Presentation ID is required');
    expect(() => presentationsApi.imageUrl(PROJECT_ID, PRESENTATION_ID, 0)).toThrow('Page number must be a positive safe integer');
    expect(() => presentationsApi.imageUrl(PROJECT_ID, PRESENTATION_ID, 1.5)).toThrow('Page number must be a positive safe integer');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('builds only the fixed server-owned page image endpoint', () => {
    expect(presentationsApi.imageUrl('project/%2F', 'deck/one', 12)).toBe(
      'http://localhost:3000/api/projects/project%2F%252F/presentations/deck%2Fone/pages/12/image',
    );
  });

  it('uses ApiError for network failures without exposing raw messages', async () => {
    fetchMock.mockRejectedValueOnce(new Error('/Users/person/private/deck.pdf'));

    await expect(presentationsApi.list(PROJECT_ID)).rejects.toEqual(
      expect.objectContaining({
        message: 'Unable to reach the server',
        code: 'network_error',
      }),
    );
  });
});
