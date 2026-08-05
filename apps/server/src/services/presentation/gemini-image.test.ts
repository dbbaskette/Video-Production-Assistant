import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GEMINI_IMAGE_TIMEOUT_MS,
  MAX_INLINE_IMAGE_BYTES,
  GeminiImageTransport,
  GeminiImageTransportError,
  type GenerateWithImageInput,
} from './gemini-image.js';

const imageBytes = Buffer.from('private normalized PNG bytes');

function input(overrides: Partial<GenerateWithImageInput> = {}): GenerateWithImageInput {
  return {
    apiKey: 'private/key?with&reserved=characters',
    model: 'gemini-2.5-pro',
    systemPrompt: 'Exact system prompt.',
    userPrompt: 'Analyze slide 1.',
    imagePath: '/private/project/presentations/private/pages/page-0001.png',
    imageMimeType: 'image/png',
    responseMimeType: 'application/json',
    maxTokens: 4_096,
    ...overrides,
  };
}

function success(text = '{"visual_summary":"Safe output"}'): Response {
  return new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text }] } }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function transport(options: {
  fetch?: typeof fetch;
  readFile?: (path: string) => Promise<Buffer>;
} = {}) {
  const fetchRequest = options.fetch ?? vi.fn(async () => success());
  const readFile = options.readFile ?? vi.fn(async () => imageBytes);
  return {
    instance: new GeminiImageTransport({ fetch: fetchRequest, readFile }),
    fetchRequest,
    readFile,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('GeminiImageTransport', () => {
  it('sends one inline PNG before the user prompt with exact system and response controls', async () => {
    const ctx = transport();

    await expect(ctx.instance.generateWithImage(input())).resolves.toBe('{"visual_summary":"Safe output"}');

    expect(ctx.readFile).toHaveBeenCalledOnce();
    expect(ctx.readFile).toHaveBeenCalledWith(input().imagePath);
    expect(ctx.fetchRequest).toHaveBeenCalledOnce();
    const [requestUrl, requestInit] = vi.mocked(ctx.fetchRequest).mock.calls[0]!;
    const url = new URL(String(requestUrl));
    expect(url.origin + url.pathname).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent',
    );
    expect(url.searchParams.get('key')).toBe(input().apiKey);
    expect(String(requestUrl)).not.toContain(input().apiKey);
    expect(requestInit?.headers).toEqual({ 'content-type': 'application/json' });
    const bodyText = String(requestInit?.body);
    const body = JSON.parse(bodyText);
    expect(body.system_instruction).toEqual({ parts: [{ text: input().systemPrompt }] });
    expect(body.contents[0].parts).toEqual([
      { inline_data: { mime_type: 'image/png', data: imageBytes.toString('base64') } },
      { text: 'Analyze slide 1.' },
    ]);
    expect(body.generationConfig).toEqual({
      responseMimeType: 'application/json',
      maxOutputTokens: 4_096,
    });
    expect(bodyText).not.toContain(input().apiKey);
    expect(bodyText.match(new RegExp(imageBytes.toString('base64'), 'g'))).toHaveLength(1);
  });

  it('aborts after exactly sixty seconds and clears the timeout resource', async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const fetchSpy = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      requestSignal = init?.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener('abort', () => reject(new DOMException('private abort', 'AbortError')));
      });
    });
    const fetchRequest = fetchSpy as unknown as typeof fetch;
    const ctx = transport({ fetch: fetchRequest });

    const pending = ctx.instance.generateWithImage(input());
    const rejection = expect(pending).rejects.toEqual(new GeminiImageTransportError());
    for (let turn = 0; turn < 10 && fetchSpy.mock.calls.length === 0; turn += 1) {
      await Promise.resolve();
    }
    expect(fetchRequest).toHaveBeenCalledOnce();
    expect(requestSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(GEMINI_IMAGE_TIMEOUT_MS - 1);
    expect(requestSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await rejection;
    expect(requestSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['non-2xx response', () => new Response('private provider body', { status: 403 })],
    ['malformed JSON', () => new Response('{private malformed', { status: 200 })],
    ['missing candidates', () => new Response('{}', { status: 200 })],
    ['missing content', () => new Response('{"candidates":[{}]}', { status: 200 })],
    ['missing parts', () => new Response('{"candidates":[{"content":{}}]}', { status: 200 })],
    ['missing text', () => new Response('{"candidates":[{"content":{"parts":[{}]}}]}', { status: 200 })],
    ['empty text', () => success('   ')],
  ])('returns the same bounded error for %s without private material', async (_label, response) => {
    const privateResponse = response();
    const ctx = transport({ fetch: vi.fn(async () => privateResponse) as unknown as typeof fetch });

    const error = await ctx.instance.generateWithImage(input()).catch((caught: unknown) => caught);

    expect(error).toEqual(new GeminiImageTransportError());
    const serialized = JSON.stringify(error);
    for (const secret of [
      'private provider body', input().apiKey, input().imagePath, imageBytes.toString('base64'),
      'generativelanguage.googleapis.com', 'private malformed',
    ]) {
      expect(`${String(error)} ${serialized}`).not.toContain(secret);
    }
  });

  it.each([
    ['fetch rejection', new Error('private network details')],
    ['abort rejection', new DOMException('private abort details', 'AbortError')],
  ])('sanitizes %s', async (_label, rejection) => {
    const ctx = transport({
      fetch: vi.fn(async () => { throw rejection; }) as unknown as typeof fetch,
    });

    await expect(ctx.instance.generateWithImage(input())).rejects.toEqual(new GeminiImageTransportError());
  });

  it.each([
    ['empty image', Buffer.alloc(0)],
    ['oversized image', Buffer.alloc(MAX_INLINE_IMAGE_BYTES + 1)],
  ])('rejects an %s before making a provider call', async (_label, bytes) => {
    const ctx = transport({ readFile: vi.fn(async () => bytes) });

    await expect(ctx.instance.generateWithImage(input())).rejects.toEqual(new GeminiImageTransportError());

    expect(ctx.readFile).toHaveBeenCalledOnce();
    expect(ctx.fetchRequest).not.toHaveBeenCalled();
  });

  it.each([
    { model: '../private?key=x' },
    { systemPrompt: '' },
    { systemPrompt: 'x'.repeat(20_001) },
    { userPrompt: '' },
    { userPrompt: 'x'.repeat(30_001) },
    { imagePath: '' },
    { imageMimeType: 'image/jpeg' as 'image/png' },
    { responseMimeType: 'text/plain' as 'application/json' },
    { maxTokens: 0 },
    { maxTokens: 8_193 },
    { apiKey: '' },
  ])('rejects invalid bounded input before reading or sending: %j', async (override) => {
    const ctx = transport();

    await expect(ctx.instance.generateWithImage(input(override))).rejects.toEqual(new GeminiImageTransportError());

    expect(ctx.readFile).not.toHaveBeenCalled();
    expect(ctx.fetchRequest).not.toHaveBeenCalled();
  });

  it('bounds successful provider output before parsing it', async () => {
    const response = success('x'.repeat(1_000_001));
    const ctx = transport({ fetch: vi.fn(async () => response) as unknown as typeof fetch });

    await expect(ctx.instance.generateWithImage(input())).rejects.toEqual(new GeminiImageTransportError());
  });
});
