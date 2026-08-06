import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateMusic, LyriaError } from './lyria.js';

describe('generateMusic', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses the documented default MP3 request without overriding response modalities', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  { text: '[Instrumental]' },
                  {
                    inline_data: {
                      mime_type: 'audio/mp3',
                      data: Buffer.from('test audio').toString('base64'),
                    },
                  },
                ],
              },
              finishReason: 'STOP',
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await generateMusic({ prompt: 'Calm instrumental underscore', model: 'clip' }, 'test-key');

    const request = fetchMock.mock.calls[0]![1]!;
    expect(JSON.parse(String(request.body))).toEqual({
      contents: [{ parts: [{ text: 'Calm instrumental underscore' }] }],
    });
  });

  it('includes the candidate finish reason when a successful response has no audio', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: { parts: [{ text: 'Unable to generate this track.' }] },
                finishReason: 'SAFETY',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    const error = await generateMusic(
      { prompt: 'A test prompt', model: 'clip' },
      'test-key',
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(LyriaError);
    expect(error).toMatchObject({ code: 'safety_blocked', status: 200 });
    expect((error as Error).message).toContain('SAFETY');
  });
});
