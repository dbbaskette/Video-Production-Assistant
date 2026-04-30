import { describe, it, expect, vi, beforeEach } from 'vitest';
import { extract } from './index.js';
import * as detect from './detect.js';
import * as md from './markitdown.js';
import * as fp from './fallback-pdf.js';
import * as fu from './fallback-url.js';

vi.mock('./detect.js');
vi.mock('./markitdown.js');
vi.mock('./fallback-pdf.js');
vi.mock('./fallback-url.js');

describe('extract orchestrator', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('uses MarkItDown when available for a PDF', async () => {
    (detect.detectMarkItDown as any).mockResolvedValue({ available: true, version: '0.0.1' });
    (md.extractWithMarkItDown as any).mockResolvedValue('# from markitdown');
    const out = await extract({ kind: 'file', path: '/tmp/x.pdf' });
    expect(out.markdown).toContain('from markitdown');
    expect(out.extractor).toBe('markitdown');
  });

  it('falls back to pdf-parse when MarkItDown is unavailable', async () => {
    (detect.detectMarkItDown as any).mockResolvedValue({ available: false });
    (fp.extractPdfFallback as any).mockResolvedValue('plain text from pdf');
    const out = await extract({ kind: 'file', path: '/tmp/x.pdf' });
    expect(out.markdown).toContain('plain text');
    expect(out.extractor).toBe('pdf-parse');
  });

  it('uses MarkItDown for URL when available', async () => {
    (detect.detectMarkItDown as any).mockResolvedValue({ available: true, version: '0.0.1' });
    (md.extractWithMarkItDown as any).mockResolvedValue('# url via markitdown');
    const out = await extract({ kind: 'url', url: 'https://x.example' });
    expect(out.extractor).toBe('markitdown');
  });

  it('falls back to readability for URL when MarkItDown unavailable', async () => {
    (detect.detectMarkItDown as any).mockResolvedValue({ available: false });
    (fu.extractUrlFallback as any).mockResolvedValue('article body');
    const out = await extract({ kind: 'url', url: 'https://x.example' });
    expect(out.extractor).toBe('readability');
  });

  it('reads markdown files directly without LLM extraction', async () => {
    const mockReadFile = vi.fn().mockResolvedValue('# Already markdown');
    const out = await extract({ kind: 'file', path: '/tmp/x.md' }, { __readFile: mockReadFile });
    expect(out.markdown).toBe('# Already markdown');
    expect(out.extractor).toBe('passthrough');
  });

  it('passes through free-text input', async () => {
    const out = await extract({ kind: 'text', text: 'My brand is bold and clean' });
    expect(out.markdown).toBe('My brand is bold and clean');
    expect(out.extractor).toBe('passthrough');
  });

  it('rejects unsupported file format with fallback path active', async () => {
    (detect.detectMarkItDown as any).mockResolvedValue({ available: false });
    await expect(extract({ kind: 'file', path: '/tmp/x.docx' })).rejects.toThrow(/MarkItDown/i);
  });
});
