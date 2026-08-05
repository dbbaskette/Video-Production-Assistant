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

describe('presentationsApi', () => {
  const fetchMock = vi.fn<[RequestInfo | URL, RequestInit?], Promise<Response>>();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('uploads exact multipart fields without setting the FormData content type', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ presentation_id: PRESENTATION_ID, job: job() }, 202));
    const file = new File(['%PDF'], 'quarterly.pdf', { type: 'application/pdf' });

    await expect(presentationsApi.upload(PROJECT_ID, file, true)).resolves.toEqual(job());

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`http://localhost:3000/api/projects/${PROJECT_ID}/presentations`);
    expect(init?.method).toBe('POST');
    expect(init?.headers).toBeUndefined();
    expect(init?.body).toBeInstanceOf(FormData);
    const form = init?.body as FormData;
    expect(form.get('file')).toBe(file);
    expect(form.get('generate_narration')).toBe('true');
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

  it('uses one five-minute timeout and clears it after an aborted upload', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('private detail', 'AbortError')));
    }));

    const result = presentationsApi.upload(PROJECT_ID, new File(['x'], 'deck.pdf'), false);
    const rejection = expect(result).rejects.toMatchObject({
      name: 'ApiError',
      message: 'Presentation upload timed out',
      code: 'request_timeout',
    });
    await vi.advanceTimersByTimeAsync(300_000);

    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the upload timeout after success', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(jsonResponse({ presentation_id: PRESENTATION_ID, job: job() }, 202));

    await presentationsApi.upload(PROJECT_ID, new File(['x'], 'deck.pdf'), false);

    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the five-minute abort lifecycle active while reading the upload response', async () => {
    vi.useFakeTimers();
    let signal!: AbortSignal;
    let resolveBody!: (body: string) => void;
    fetchMock.mockImplementationOnce(async (_url, init) => {
      signal = init!.signal as AbortSignal;
      return {
        ok: true,
        status: 202,
        text: () => new Promise<string>((resolve) => { resolveBody = resolve; }),
      } as Response;
    });
    const result = presentationsApi.upload(PROJECT_ID, new File(['x'], 'deck.pdf'), false);
    const rejection = expect(result).rejects.toMatchObject({ code: 'request_timeout' });
    await vi.waitFor(() => expect(resolveBody).toBeTypeOf('function'));

    await vi.advanceTimersByTimeAsync(300_000);
    const abortedDuringBodyRead = signal.aborted;
    resolveBody(JSON.stringify({ presentation_id: PRESENTATION_ID, job: job() }));
    await rejection;

    expect(abortedDuringBodyRead).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects malformed successful wrappers and direct jobs', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ presentation_id: PRESENTATION_ID, job: job(), extra: true }, 202))
      .mockResolvedValueOnce(jsonResponse({ presentations: [job()], extra: true }))
      .mockResolvedValueOnce(jsonResponse({ ...job(), filename: '' }));

    await expect(presentationsApi.upload(PROJECT_ID, new File(['x'], 'deck.pdf'), true))
      .rejects.toMatchObject({ name: 'ApiError', code: 'invalid_response' });
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
