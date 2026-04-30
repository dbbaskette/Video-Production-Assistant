import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { extractUrlFallback } from './fallback-url.js';

const SAMPLE_HTML = `
<!doctype html>
<html><head><title>Acme Brand</title></head>
<body>
  <header>nav stuff</header>
  <article>
    <h1>Acme Visual Identity</h1>
    <p>Our primary color is <strong>#FF6B35</strong>. We use Inter for headings.</p>
  </article>
  <footer>copyright</footer>
</body></html>
`;

describe('extractUrlFallback', () => {
  beforeEach(() => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(SAMPLE_HTML),
    } as any);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('strips chrome and returns the article body as markdown', async () => {
    const out = await extractUrlFallback('https://acme.example/brand');
    expect(out).toContain('Acme Visual Identity');
    expect(out).toContain('#FF6B35');
    expect(out).not.toContain('nav stuff');
    expect(out).not.toContain('copyright');
  });

  it('throws on non-OK response', async () => {
    (global.fetch as any).mockResolvedValueOnce({ ok: false, status: 404 } as any);
    await expect(extractUrlFallback('https://x.example')).rejects.toThrow(/404/);
  });
});
