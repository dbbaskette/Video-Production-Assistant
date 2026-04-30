import { extname } from 'node:path';
import { readFile } from 'node:fs/promises';
import { detectMarkItDown } from './detect.js';
import { extractWithMarkItDown } from './markitdown.js';
import { extractPdfFallback } from './fallback-pdf.js';
import { extractUrlFallback } from './fallback-url.js';

export type ExtractInput =
  | { kind: 'file'; path: string }
  | { kind: 'url';  url: string }
  | { kind: 'text'; text: string };

export interface ExtractResult {
  markdown: string;
  extractor: 'markitdown' | 'pdf-parse' | 'readability' | 'passthrough';
}

export interface ExtractOptions {
  __readFile?: typeof readFile;
}

const PASSTHROUGH_EXTS = new Set(['.md', '.markdown', '.txt', '.yaml', '.yml']);

export async function extract(input: ExtractInput, opts: ExtractOptions = {}): Promise<ExtractResult> {
  const readFn = opts.__readFile ?? readFile;

  if (input.kind === 'text') {
    return { markdown: input.text, extractor: 'passthrough' };
  }

  if (input.kind === 'file') {
    const ext = extname(input.path).toLowerCase();
    if (PASSTHROUGH_EXTS.has(ext)) {
      const content = await readFn(input.path, 'utf8');
      return { markdown: content as string, extractor: 'passthrough' };
    }
    const status = await detectMarkItDown();
    if (status.available) {
      return { markdown: await extractWithMarkItDown(input.path), extractor: 'markitdown' };
    }
    if (ext === '.pdf') {
      return { markdown: await extractPdfFallback(input.path), extractor: 'pdf-parse' };
    }
    throw new Error(`Format ${ext} requires MarkItDown. Install: pip install markitdown[all]`);
  }

  // url
  const status = await detectMarkItDown();
  if (status.available) {
    return { markdown: await extractWithMarkItDown(input.url), extractor: 'markitdown' };
  }
  return { markdown: await extractUrlFallback(input.url), extractor: 'readability' };
}
