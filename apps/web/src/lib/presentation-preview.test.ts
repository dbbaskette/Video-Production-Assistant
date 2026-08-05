import { describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('pdfjs-dist', () => ({
  getDocument: vi.fn(),
  GlobalWorkerOptions: { workerSrc: '' },
}));

import {
  createPresentationPreviewer,
  PresentationPreviewError,
  type PresentationCanvas,
  type PresentationPdfDocument,
  type PresentationPdfLoadingTask,
  type PresentationPdfPage,
} from './presentation-preview.js';

interface PdfHarness {
  loadPdf: Mock<[ArrayBuffer], PresentationPdfLoadingTask>;
  canvasFactory: Mock<[number?, number?], PresentationCanvas>;
  taskDestroy: Mock<[], Promise<void>>;
  documentDestroy: Mock<[], Promise<void>>;
  pageCleanup: Mock<[], void>;
  renderCancel: Mock<[], void>;
  canvases: PresentationCanvas[];
  dataUrls: string[];
}

function harness(options: {
  pageCount?: number;
  width?: number;
  height?: number;
  taskPromise?: Promise<PresentationPdfDocument>;
  taskFailure?: unknown;
  pageFailure?: unknown;
  renderFailure?: unknown;
  canvasFailure?: unknown;
  canvasContextFailure?: unknown;
  viewportFailure?: unknown;
} = {}): PdfHarness {
  const taskDestroy = vi.fn<[], Promise<void>>(async () => undefined);
  const documentDestroy = vi.fn<[], Promise<void>>(async () => undefined);
  const pageCleanup = vi.fn<[], void>(() => undefined);
  const renderCancel = vi.fn<[], void>(() => undefined);
  const canvases: PresentationCanvas[] = [];
  const dataUrls: string[] = [];
  const pageCount = options.pageCount ?? 6;
  const document: PresentationPdfDocument = {
    numPages: pageCount,
    getPage: vi.fn(async (pageNumber: number): Promise<PresentationPdfPage> => {
      if (options.pageFailure !== undefined) throw options.pageFailure;
      return {
        getViewport: ({ scale }) => {
          if (options.viewportFailure !== undefined) throw options.viewportFailure;
          return {
            width: (options.width ?? 640) * scale,
            height: (options.height ?? 480) * scale,
          };
        },
        render: () => ({
          promise: options.renderFailure === undefined
            ? Promise.resolve()
            : Promise.reject(options.renderFailure),
          cancel: renderCancel,
        }),
        cleanup: pageCleanup,
      };
    }),
    destroy: documentDestroy,
  };
  const loadPdf = vi.fn((_data: ArrayBuffer): PresentationPdfLoadingTask => ({
    promise: options.taskPromise
      ?? (options.taskFailure === undefined ? Promise.resolve(document) : Promise.reject(options.taskFailure)),
    destroy: taskDestroy,
    onPassword: null,
  }));
  const canvasFactory = vi.fn<[number?, number?], PresentationCanvas>(() => {
    if (options.canvasFailure !== undefined) throw options.canvasFailure;
    const index = canvases.length;
    const canvas: PresentationCanvas = {
      width: 0,
      height: 0,
      getContext: () => {
        if (options.canvasContextFailure !== undefined) throw options.canvasContextFailure;
        return { marker: '2d' } as unknown as CanvasRenderingContext2D;
      },
      toDataURL: () => {
        const value = `data:image/png;base64,page-${index + 1}`;
        dataUrls.push(value);
        return value;
      },
    };
    canvases.push(canvas);
    return canvas;
  });
  return {
    loadPdf,
    canvasFactory,
    taskDestroy,
    documentDestroy,
    pageCleanup,
    renderCancel,
    canvases,
    dataUrls,
  };
}

function file(name = 'slides.PDF', sizeBytes = 4): File {
  return new File([new Uint8Array(sizeBytes)], name, { type: 'application/pdf' });
}

describe('previewPresentation', () => {
  it('renders the first four pages in order while reporting the complete page count', async () => {
    const pdf = harness({ pageCount: 7 });
    const preview = createPresentationPreviewer(pdf);

    await expect(preview(file())).resolves.toEqual({
      pageCount: 7,
      thumbnails: [1, 2, 3, 4].map((pageNumber) => ({
        pageNumber,
        dataUrl: `data:image/png;base64,page-${pageNumber}`,
      })),
    });
    expect(pdf.loadPdf).toHaveBeenCalledTimes(1);
    expect(pdf.pageCleanup).toHaveBeenCalledTimes(4);
    expect(pdf.documentDestroy).toHaveBeenCalledTimes(1);
    expect(pdf.canvases.every((canvas) => canvas.width === 0 && canvas.height === 0)).toBe(true);
  });

  it.each([
    ['wide page', 640, 480, 320, 240],
    ['narrow page', 100, 50, 100, 50],
    ['fractional tiny page', 0.2, 0.1, 1, 1],
  ] as const)('scales a %s proportionally within 320 CSS pixels', async (_name, width, height, expectedWidth, expectedHeight) => {
    const pdf = harness({ pageCount: 1, width, height });
    const dimensions: Array<[number, number]> = [];
    pdf.canvasFactory.mockImplementation(() => {
      const canvas: PresentationCanvas = {
        width: 0,
        height: 0,
        getContext: () => ({} as CanvasRenderingContext2D),
        toDataURL() {
          dimensions.push([this.width, this.height]);
          return 'data:image/png;base64,page';
        },
      };
      pdf.canvases.push(canvas);
      return canvas;
    });

    await previewWith(pdf, file());

    expect(dimensions).toEqual([[expectedWidth, expectedHeight]]);
  });

  it.each([
    ['malformed', { name: 'InvalidPDFException', message: '/private/file and parser stack' }, 'invalid-pdf'],
    ['encrypted', { name: 'PasswordException', message: 'password detail' }, 'password-required'],
  ] as const)('maps %s loading failures to stable errors', async (_name, failure, code) => {
    const pdf = harness({ taskFailure: failure });

    const result = previewWith(pdf, file()).catch((error: unknown) => error);

    await expect(result).resolves.toMatchObject({ name: 'PresentationPreviewError', code });
    const error = await result as PresentationPreviewError;
    expect(error.message).not.toContain(failure.message);
    expect(error.stack).not.toContain(failure.message);
    expect(pdf.taskDestroy).toHaveBeenCalledTimes(1);
  });

  it('rejects a password callback without waiting for PDF.js to publish a document', async () => {
    const never = new Promise<PresentationPdfDocument>(() => undefined);
    const pdf = harness({ taskPromise: never });
    pdf.loadPdf.mockImplementation((_data) => ({
      promise: never,
      destroy: pdf.taskDestroy,
      onPassword: null,
    }));
    const preview = createPresentationPreviewer(pdf);
    const result = preview(file());
    await vi.waitFor(() => expect(pdf.loadPdf).toHaveBeenCalledTimes(1));
    const task = pdf.loadPdf.mock.results[0]!.value;

    task.onPassword?.(() => undefined, 1);

    await expect(result).rejects.toMatchObject({ code: 'password-required' });
    expect(pdf.taskDestroy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['empty page count', harness({ pageCount: 0 }), 'empty-pdf'],
    ['page read', harness({ pageFailure: new Error('private page') }), 'page-render-failed'],
    ['page viewport', harness({ viewportFailure: new Error('private viewport') }), 'page-render-failed'],
    ['page render', harness({ renderFailure: new Error('private renderer') }), 'page-render-failed'],
    ['canvas creation', harness({ canvasFailure: new Error('private canvas') }), 'canvas-failed'],
    ['canvas context', harness({ canvasContextFailure: new Error('private canvas context') }), 'canvas-failed'],
  ] as const)('maps %s failures to stable errors and releases resources', async (_name, pdf, code) => {
    const result = previewWith(pdf, file()).catch((error: unknown) => error);

    await expect(result).resolves.toMatchObject({ name: 'PresentationPreviewError', code });
    const error = await result as PresentationPreviewError;
    expect(error.message).not.toContain('private');
    expect(pdf.documentDestroy).toHaveBeenCalledTimes(1);
    expect(pdf.canvases.every((canvas) => canvas.width === 0 && canvas.height === 0)).toBe(true);
  });

  it.each(['slides.txt', 'slides.pdf.exe', '.pdf-not'])('rejects non-PDF names before reading or loading: %s', async (name) => {
    const pdf = harness();
    const input = file(name);
    const read = vi.spyOn(input, 'arrayBuffer');

    await expect(previewWith(pdf, input)).rejects.toMatchObject({ code: 'invalid-file-type' });
    expect(read).not.toHaveBeenCalled();
    expect(pdf.loadPdf).not.toHaveBeenCalled();
  });

  it('rejects files over 100 MB before reading or loading', async () => {
    const pdf = harness();
    const input = file();
    Object.defineProperty(input, 'size', { value: 100 * 1024 * 1024 + 1 });
    const read = vi.spyOn(input, 'arrayBuffer');

    await expect(previewWith(pdf, input)).rejects.toMatchObject({ code: 'file-too-large' });
    expect(read).not.toHaveBeenCalled();
    expect(pdf.loadPdf).not.toHaveBeenCalled();
  });

  it('reads the accepted file exactly once', async () => {
    const pdf = harness({ pageCount: 1 });
    const input = file();
    const read = vi.spyOn(input, 'arrayBuffer');

    await previewWith(pdf, input);

    expect(read).toHaveBeenCalledTimes(1);
  });

  it('supersedes prior loading work and prevents stale thumbnails from publishing', async () => {
    let resolveOld!: (document: PresentationPdfDocument) => void;
    const oldDocument = deferredDocument(1);
    const oldTaskPromise = new Promise<PresentationPdfDocument>((resolve) => { resolveOld = resolve; });
    const oldPdf = harness({ taskPromise: oldTaskPromise });
    const newPdf = harness({ pageCount: 1 });
    const loadPdf = vi.fn()
      .mockImplementationOnce(oldPdf.loadPdf)
      .mockImplementationOnce(newPdf.loadPdf);
    const preview = createPresentationPreviewer({ loadPdf, canvasFactory: newPdf.canvasFactory });

    const oldResult = preview(file('old.pdf'));
    const oldRejection = expect(oldResult).rejects.toMatchObject({ code: 'superseded' });
    await vi.waitFor(() => expect(loadPdf).toHaveBeenCalledTimes(1));
    const newResult = preview(file('new.pdf'));
    await expect(newResult).resolves.toMatchObject({ pageCount: 1 });
    resolveOld(oldDocument.document);

    await oldRejection;
    expect(oldPdf.taskDestroy).toHaveBeenCalledTimes(1);
    expect(oldDocument.destroy).toHaveBeenCalledTimes(1);
    expect(oldDocument.getPage).not.toHaveBeenCalled();
  });

  it('cancels an in-flight render and releases its page and canvas on supersession', async () => {
    let rejectRender!: (error: unknown) => void;
    const renderPromise = new Promise<void>((_resolve, reject) => { rejectRender = reject; });
    const pageCleanup = vi.fn();
    const renderCancel = vi.fn(() => rejectRender(new Error('RenderingCancelledException')));
    const render = vi.fn(() => ({ promise: renderPromise, cancel: renderCancel }));
    const firstDocument = deferredDocument(1, {
      getViewport: () => ({ width: 640, height: 480 }),
      render,
      cleanup: pageCleanup,
    });
    const firstTaskDestroy = vi.fn(async () => undefined);
    const second = harness({ pageCount: 1 });
    const canvases: PresentationCanvas[] = [];
    const canvasFactory = vi.fn(() => {
      const canvas: PresentationCanvas = {
        width: 0,
        height: 0,
        getContext: () => ({} as CanvasRenderingContext2D),
        toDataURL: () => 'data:image/png;base64,page',
      };
      canvases.push(canvas);
      return canvas;
    });
    const loadPdf = vi.fn()
      .mockReturnValueOnce({ promise: Promise.resolve(firstDocument.document), destroy: firstTaskDestroy, onPassword: null })
      .mockImplementationOnce(second.loadPdf);
    const preview = createPresentationPreviewer({ loadPdf, canvasFactory });

    const first = preview(file('first.pdf'));
    await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(1));
    const secondResult = preview(file('second.pdf'));

    await expect(first).rejects.toMatchObject({ code: 'superseded' });
    await expect(secondResult).resolves.toMatchObject({ pageCount: 1 });
    expect(renderCancel).toHaveBeenCalledTimes(1);
    expect(pageCleanup).toHaveBeenCalledTimes(1);
    expect(canvases.every((canvas) => canvas.width === 0 && canvas.height === 0)).toBe(true);
  });

  it('does not let an older call cancel a newer task during older cleanup', async () => {
    let resolveOld!: (document: PresentationPdfDocument) => void;
    const oldTask = harness({ taskPromise: new Promise((resolve) => { resolveOld = resolve; }) });
    const newer = harness({ pageCount: 1 });
    const loadPdf = vi.fn()
      .mockImplementationOnce(oldTask.loadPdf)
      .mockImplementationOnce(newer.loadPdf);
    const preview = createPresentationPreviewer({ loadPdf, canvasFactory: newer.canvasFactory });

    const oldResult = preview(file('old.pdf'));
    const oldRejection = expect(oldResult).rejects.toMatchObject({ code: 'superseded' });
    await vi.waitFor(() => expect(loadPdf).toHaveBeenCalledTimes(1));
    const newResult = preview(file('new.pdf'));
    await vi.waitFor(() => expect(loadPdf).toHaveBeenCalledTimes(2));
    resolveOld(deferredDocument(1).document);

    await oldRejection;
    await expect(newResult).resolves.toMatchObject({ pageCount: 1 });
    expect(newer.taskDestroy).not.toHaveBeenCalled();
    expect(newer.documentDestroy).toHaveBeenCalledTimes(1);
  });
});

function previewWith(pdf: PdfHarness, input: File) {
  return createPresentationPreviewer(pdf)(input);
}

function deferredDocument(pageCount: number, page?: PresentationPdfPage) {
  const destroy = vi.fn(async () => undefined);
  const getPage = vi.fn(async () => page ?? ({
    getViewport: () => ({ width: 640, height: 480 }),
    render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }),
    cleanup: vi.fn(),
  }));
  return {
    document: { numPages: pageCount, getPage, destroy } satisfies PresentationPdfDocument,
    destroy,
    getPage,
  };
}
