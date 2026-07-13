import { describe, it, expect, vi, afterEach } from 'vitest';
import { createXaiTtsProvider } from './xai.js';

/**
 * Regression: xAI's /v1/tts vocalizes inline/wrapping tags as literal text
 * (verified empirically — `<emphasis>`, `[pause]`, `<slow>` etc. are spoken,
 * not honored). So the provider must send fully tag-stripped text; otherwise
 * the narration audio starts with spoken markup.
 */
describe('xAI provider — never sends expressive tags to /v1/tts', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('strips all xAI markup from the text sent to the API', async () => {
    let sentBody: { text: string } | null = null;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      sentBody = JSON.parse(init.body as string);
      return {
        ok: true,
        status: 200,
        headers: new Map(),
        arrayBuffer: async () => new ArrayBuffer(16),
      } as unknown as Response;
    }));

    const provider = createXaiTtsProvider('test-key');
    await provider.generate(
      '<slow><soft>This is</soft></slow> [pause] <strong>scene one.</strong> [long-pause] Ready?',
      { voice: 'Sal' },
    );

    expect(sentBody).not.toBeNull();
    const text: string = sentBody!.text;
    // No angle-bracket or square-bracket tags may reach xAI.
    expect(text.includes('<') || text.includes('[')).toBe(false);
    expect(text).toBe('This is scene one. Ready?');
  });
});
