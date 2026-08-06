import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { getDocument, type PDFDocumentLoadingTask, type PDFDocumentProxy, type PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';

const MAX_RENDER_WIDTH = 1920;
const MAX_RENDER_HEIGHT = 1080;

export interface PdfLimits {
  maxPages: number;
  maxTextCharsPerPage: number;
}

export interface PdfPageHandle {
  pageNumber: number;
  width: number;
  height: number;
  rotation: number;
  text: string;
  heading?: string;
  render(destination: string): Promise<void>;
}

export interface PdfInspection {
  pageCount: number;
  pages: PdfPageHandle[];
  close(): Promise<void>;
}

export type PresentationPdfErrorCode = 'encrypted_pdf' | 'invalid_pdf' | 'page_limit_exceeded';

export class PresentationPdfError extends Error {
  constructor(readonly code: PresentationPdfErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PresentationPdfError';
  }
}

function errorForPdfFailure(error: unknown): PresentationPdfError {
  if (error instanceof PresentationPdfError) return error;
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : 'Unable to read PDF';
  if (name === 'PasswordException' || /password|encrypted/i.test(message)) {
    return new PresentationPdfError('encrypted_pdf', 'Password-protected PDFs are not supported', { cause: error });
  }
  return new PresentationPdfError('invalid_pdf', 'The file is not a valid PDF', { cause: error });
}

function textFromPageContent(items: Awaited<ReturnType<PDFPageProxy['getTextContent']>>['items'], limit: number): string {
  let text = '';
  let previousY: number | undefined;
  for (const item of items) {
    if (!('str' in item) || typeof item.str !== 'string') continue;
    const y = item.transform[5];
    if (text.length > 0 && previousY !== undefined && Math.abs(y - previousY) > 0.1) text += '\n';
    text += item.str;
    previousY = y;
    if (text.length >= limit) return text.slice(0, limit);
  }
  return text;
}

function headingFromText(text: string): string | undefined {
  return text.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length >= 1 && line.length <= 160);
}

function pageDimensions(page: PDFPageProxy): { width: number; height: number; rotation: number } {
  const rotation = ((page.rotate % 360) + 360) % 360;
  const viewport = page.getViewport({ scale: 1 });
  if (!Number.isFinite(viewport.width) || !Number.isFinite(viewport.height) || viewport.width <= 0 || viewport.height <= 0) {
    throw new PresentationPdfError('invalid_pdf', 'The PDF page has invalid dimensions');
  }
  return {
    width: viewport.width,
    height: viewport.height,
    rotation,
  };
}

async function renderPdfPage(page: PDFPageProxy, destination: string): Promise<void> {
  const dimensions = pageDimensions(page);
  const scale = Math.min(MAX_RENDER_WIDTH / dimensions.width, MAX_RENDER_HEIGHT / dimensions.height);
  const viewport = page.getViewport({ scale });
  const canvasWidth = Math.max(1, Math.min(MAX_RENDER_WIDTH, Math.ceil(viewport.width)));
  const canvasHeight = Math.max(1, Math.min(MAX_RENDER_HEIGHT, Math.ceil(viewport.height)));
  const canvas = createCanvas(canvasWidth, canvasHeight);
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvasWidth, canvasHeight);

  await page.render({ canvasContext: context as never, viewport, background: '#ffffff' }).promise;
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, canvas.toBuffer('image/png'), { mode: 0o600 });
  await chmod(destination, 0o600);
}

export async function inspectPdf(sourcePath: string, limits: PdfLimits): Promise<PdfInspection> {
  let task: PDFDocumentLoadingTask | undefined;
  let document: PDFDocumentProxy | undefined;
  try {
    const bytes = await readFile(sourcePath);
    task = getDocument({
      data: new Uint8Array(bytes),
      isEvalSupported: false,
      useSystemFonts: true,
      verbosity: 0,
    });
    document = await task.promise;
    if (document.numPages > limits.maxPages) {
      throw new PresentationPdfError('page_limit_exceeded', `PDF has more than ${limits.maxPages} pages`);
    }

    const pages: PdfPageHandle[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const dimensions = pageDimensions(page);
      const text = textFromPageContent((await page.getTextContent()).items, limits.maxTextCharsPerPage);
      pages.push({
        pageNumber,
        ...dimensions,
        text,
        heading: headingFromText(text),
        render: (destination) => renderPdfPage(page, destination),
      });
    }

    return {
      pageCount: document.numPages,
      pages,
      close: async () => {
        await task?.destroy();
      },
    };
  } catch (error) {
    await task?.destroy();
    throw errorForPdfFailure(error);
  }
}
