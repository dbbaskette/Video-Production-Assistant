import { readFile } from 'node:fs/promises';
import pdfParse from 'pdf-parse';

export interface FallbackPdfOptions {
  __injectText?: string;
}

export async function extractPdfFallback(path: string, opts: FallbackPdfOptions = {}): Promise<string> {
  let text: string;
  if (opts.__injectText !== undefined) {
    text = opts.__injectText;
  } else {
    const buf = await readFile(path);
    const result = await pdfParse(buf);
    text = result.text;
  }
  return text
    .replace(/\f/g, '\n\n---\n\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line, i, all) => !(line === '' && all[i - 1] === ''))
    .join('\n')
    .trim();
}
