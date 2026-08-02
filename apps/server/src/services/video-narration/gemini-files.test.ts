import { describe, expect, it, vi } from 'vitest';
import { createGeminiFilesTransport, type GeminiFile } from './gemini-files.js';

const file: GeminiFile = {
  name: 'files/abc',
  uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc',
  mimeType: 'video/mp4',
  state: 'PROCESSING',
};

describe('Gemini Files transport', () => {
  it('uses injected filesystem and network dependencies for upload', async () => {
    const fetchRequest = vi.fn(async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<Response> => new Response())
      .mockResolvedValueOnce(new Response(null, {
        status: 200,
        headers: { 'x-goog-upload-url': 'https://upload.invalid/session' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ file }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    const readFile = vi.fn(async () => Buffer.from('bytes'));
    const stat = vi.fn(async () => ({ size: 5 }) as Awaited<ReturnType<typeof import('node:fs/promises').stat>>);
    const transport = createGeminiFilesTransport({
      fetch: fetchRequest as unknown as typeof fetch,
      readFile: readFile as unknown as typeof import('node:fs/promises').readFile,
      stat: stat as unknown as typeof import('node:fs/promises').stat,
    });

    await expect(transport.uploadVideo('key', '/recording.mp4', 'video/mp4', 'scene'))
      .resolves.toEqual(file);

    expect(stat).toHaveBeenCalledWith('/recording.mp4');
    expect(readFile).toHaveBeenCalledWith('/recording.mp4');
    expect(fetchRequest).toHaveBeenCalledTimes(2);
    expect(fetchRequest.mock.calls[1]![0]).toBe('https://upload.invalid/session');
  });

  it('polls through processing with injected time and sleep', async () => {
    const fetchRequest = vi.fn(async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<Response> => new Response())
      .mockResolvedValueOnce(new Response(JSON.stringify(file), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...file, state: 'ACTIVE' }), { status: 200 }));
    let time = 0;
    const sleep = vi.fn(async (duration: number) => { time += duration; });
    const transport = createGeminiFilesTransport({
      fetch: fetchRequest as unknown as typeof fetch,
      now: () => time,
      sleep,
    });
    const states: string[] = [];

    const ready = await transport.waitForFileActive('key', 'files/abc', {
      timeoutMs: 10,
      pollIntervalMs: 1,
      onPoll: (state) => states.push(state),
    });

    expect(ready.state).toBe('ACTIVE');
    expect(states).toEqual(['PROCESSING', 'ACTIVE']);
    expect(sleep).toHaveBeenCalledWith(1);
  });

  it('sends the video URI only through generateContent with JSON response mode', async () => {
    const fetchRequest = vi.fn(async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ) => new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: '{"visual_summary":"ok"}' }] } }],
    }), { status: 200 }));
    const transport = createGeminiFilesTransport({ fetch: fetchRequest as unknown as typeof fetch });

    await expect(transport.generateWithVideo({
      apiKey: 'key',
      model: 'gemini-test',
      systemPrompt: 'system',
      userPrompt: 'user',
      videoFileUri: file.uri,
      videoMimeType: 'video/mp4',
      responseMimeType: 'application/json',
    })).resolves.toBe('{"visual_summary":"ok"}');

    const request = fetchRequest.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(String(request.body));
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.contents[0].parts[0].file_data.file_uri).toBe(file.uri);
  });

  it('reports cleanup failure as false for both HTTP and network failures', async () => {
    const httpTransport = createGeminiFilesTransport({
      fetch: vi.fn(async () => new Response(null, { status: 500 })) as unknown as typeof fetch,
    });
    const networkTransport = createGeminiFilesTransport({
      fetch: vi.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch,
    });

    await expect(httpTransport.deleteFile('key', 'files/abc')).resolves.toBe(false);
    await expect(networkTransport.deleteFile('key', 'files/abc')).resolves.toBe(false);
  });

  it('does not include provider response bodies or remote names in errors', async () => {
    const fetchRequest = vi.fn(async () => new Response(
      'secret response https://generativelanguage.googleapis.com/v1beta/files/private',
      { status: 403 },
    ));
    const transport = createGeminiFilesTransport({
      fetch: fetchRequest as unknown as typeof fetch,
      stat: vi.fn(async () => ({ size: 5 })) as unknown as typeof import('node:fs/promises').stat,
    });

    const error = await transport.uploadVideo('key', '/private/video.mp4', 'video/mp4')
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Gemini Files API: upload init failed (403)');
    expect((error as Error).message).not.toContain('/private/video.mp4');
    expect((error as Error).message).not.toContain('generativelanguage.googleapis.com');
  });
});
