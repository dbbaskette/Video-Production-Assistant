import { describe, it, expect, vi, afterEach } from 'vitest';
import { createXaiTtsProvider } from './xai.js';

/**
 * xAI Grok /v1/tts HONORS its expressive tags (verified via STT: `[pause]`,
 * `<slow>`, `<whisper>` are applied, not spoken). So the provider must PASS
 * xAI tags through — stripping only the app's own emotive words (`[warm]`).
 */
describe('xAI provider — keeps xAI tags, strips only app emotives', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('sends xAI expressive tags to the API but drops app emotive words', async () => {
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
    await provider.generate('[warm] <slow>Watch this</slow> [pause] closely.', { voice: 'Sal' });

    const text = sentBody!.text;
    // App emotive removed…
    expect(text).not.toContain('[warm]');
    // …but xAI's own tags preserved (they're honored, not spoken).
    expect(text).toContain('<slow>');
    expect(text).toContain('[pause]');
    expect(text).toBe('<slow>Watch this</slow> [pause] closely.');
  });
});
