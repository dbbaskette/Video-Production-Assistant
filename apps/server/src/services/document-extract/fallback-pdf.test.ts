import { describe, it, expect, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { extractPdfFallback } from './fallback-pdf.js';

vi.mock('node:fs/promises', async () => {
  const real = await vi.importActual<any>('node:fs/promises');
  return { ...real, readFile: vi.fn() };
});

describe('extractPdfFallback', () => {
  it('produces markdown from page-break delimited text', async () => {
    (readFile as any).mockResolvedValue(Buffer.from('mock-pdf-bytes'));
    const out = await extractPdfFallback('/tmp/x.pdf', { __injectText: 'Page 1 text\f\nPage 2 text' });
    expect(out).toMatch(/Page 1 text/);
    expect(out).toMatch(/Page 2 text/);
  });
});
