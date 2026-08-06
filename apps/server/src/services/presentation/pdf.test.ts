import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { PDFDocument, PDFName, PDFNumber, degrees, rgb, StandardFonts } from 'pdf-lib';
import { inspectPdf, PresentationPdfError } from './pdf.js';

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'vpa-presentation-pdf-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function writePdf(name: string, document: PDFDocument): Promise<string> {
  const pdfPath = path.join(directory, name);
  await writeFile(pdfPath, await document.save());
  return pdfPath;
}

function encryptedPdfBytes(): Buffer {
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n',
    '4 0 obj\n<< /Filter /Standard /V 1 /R 2 /Length 40 /O <0000000000000000000000000000000000000000000000000000000000000000> /U <0000000000000000000000000000000000000000000000000000000000000000> /P -4 >>\nendobj\n',
  ];
  const header = '%PDF-1.4\n';
  const offsets: number[] = [];
  let body = header;
  for (const object of objects) {
    offsets.push(Buffer.byteLength(body));
    body += object;
  }
  const xref = [
    'xref',
    '0 5',
    '0000000000 65535 f ',
    ...offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n `),
  ].join('\n');
  const trailer = `trailer\n<< /Size 5 /Root 1 0 R /Encrypt 4 0 R /ID [<01234567890123456789012345678901> <01234567890123456789012345678901>] >>\nstartxref\n${Buffer.byteLength(`${body}${xref}\n`)}\n%%EOF\n`;
  return Buffer.from(`${body}${xref}\n${trailer}`);
}

describe('inspectPdf', () => {
  it('extracts headings and renders a page as PNG', async () => {
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    document.addPage([960, 540]).drawText('Overview', { x: 72, y: 430, font, size: 30 });
    document.addPage([960, 540]).drawText('Architecture', { x: 72, y: 430, font, size: 30 });
    const pdfPath = await writePdf('deck.pdf', document);
    const rawPngPath = path.join(directory, 'raw.png');

    const inspected = await inspectPdf(pdfPath, { maxPages: 200, maxTextCharsPerPage: 20_000 });

    expect(inspected.pageCount).toBe(2);
    expect(inspected.pages.map((page) => page.heading)).toEqual(['Overview', 'Architecture']);
    expect(inspected.pages[0]?.text).toContain('Overview');

    await inspected.pages[0]!.render(rawPngPath);
    const image = await readFile(rawPngPath);
    expect(image.subarray(1, 4).toString()).toBe('PNG');
    await inspected.close();
  });

  it('leaves the heading undefined on a page with no text', async () => {
    const document = await PDFDocument.create();
    document.addPage();

    const inspected = await inspectPdf(await writePdf('blank.pdf', document), { maxPages: 200, maxTextCharsPerPage: 20_000 });

    expect(inspected.pages[0]?.heading).toBeUndefined();
    await inspected.close();
  });

  it('reports effective portrait dimensions and rotation for a rotated page', async () => {
    const document = await PDFDocument.create();
    const page = document.addPage([960, 540]);
    page.setRotation(degrees(90));

    const inspected = await inspectPdf(await writePdf('rotated.pdf', document), { maxPages: 200, maxTextCharsPerPage: 20_000 });

    expect(inspected.pages[0]).toMatchObject({ width: 540, height: 960, rotation: 90 });
    await inspected.close();
  });

  it('contains a UserUnit-scaled page without clipping its far edge', async () => {
    const document = await PDFDocument.create();
    const page = document.addPage([960, 540]);
    page.node.set(PDFName.of('UserUnit'), PDFNumber.of(4));
    page.drawRectangle({ x: 900, y: 20, width: 40, height: 40, color: rgb(1, 0, 0) });
    const rawPngPath = path.join(directory, 'user-unit.png');

    const inspected = await inspectPdf(await writePdf('user-unit.pdf', document), { maxPages: 200, maxTextCharsPerPage: 20_000 });
    await inspected.pages[0]!.render(rawPngPath);

    const image = await loadImage(await readFile(rawPngPath));
    const canvas = createCanvas(image.width, image.height);
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    expect([image.width, image.height]).toEqual([1920, 1080]);
    expect(Array.from(context.getImageData(1840, 1000, 1, 1).data)).toEqual([255, 0, 0, 255]);
    await inspected.close();
  });

  it('rejects documents beyond the configured page limit', async () => {
    const document = await PDFDocument.create();
    for (let index = 0; index < 201; index += 1) document.addPage();

    await expect(inspectPdf(await writePdf('too-many-pages.pdf', document), { maxPages: 200, maxTextCharsPerPage: 20_000 }))
      .rejects.toMatchObject({ code: 'page_limit_exceeded' } satisfies Partial<PresentationPdfError>);
  });

  it('maps encrypted PDF bytes to encrypted_pdf', async () => {
    const pdfPath = path.join(directory, 'encrypted.pdf');
    await writeFile(pdfPath, encryptedPdfBytes());

    await expect(inspectPdf(pdfPath, { maxPages: 200, maxTextCharsPerPage: 20_000 }))
      .rejects.toMatchObject({ code: 'encrypted_pdf' } satisfies Partial<PresentationPdfError>);
  });

  it('maps invalid PDF bytes to invalid_pdf', async () => {
    const pdfPath = path.join(directory, 'invalid.pdf');
    await writeFile(pdfPath, 'definitely not a PDF');

    await expect(inspectPdf(pdfPath, { maxPages: 200, maxTextCharsPerPage: 20_000 }))
      .rejects.toMatchObject({ code: 'invalid_pdf' } satisfies Partial<PresentationPdfError>);
  });

  it('truncates extracted text at exactly the configured limit', async () => {
    const document = await PDFDocument.create();
    const page = document.addPage([960, 540]);
    const font = await document.embedFont(StandardFonts.Helvetica);
    for (let index = 0; index < 201; index += 1) {
      page.drawText('x'.repeat(100), { x: 10, y: 500, font, size: 8 });
    }

    const inspected = await inspectPdf(await writePdf('long-text.pdf', document), { maxPages: 200, maxTextCharsPerPage: 20_000 });

    expect(inspected.pages[0]?.text).toHaveLength(20_000);
    await inspected.close();
  });
});
