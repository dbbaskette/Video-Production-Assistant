import {
  getDocument,
  GlobalWorkerOptions,
} from 'pdfjs-dist';

GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

const MAX_PREVIEW_BYTES = 100 * 1024 * 1024;
const MAX_THUMBNAILS = 4;
const MAX_THUMBNAIL_WIDTH = 320;
/** Bounds pathological portrait pages before canvas allocation and encoding. */
const MAX_THUMBNAIL_HEIGHT = 320;
/** Four maximally sized thumbnails; checked cumulatively before allocation. */
const MAX_PREVIEW_PIXEL_AREA = MAX_THUMBNAILS * MAX_THUMBNAIL_WIDTH * MAX_THUMBNAIL_HEIGHT;

export interface PresentationPreview {
  pageCount: number;
  thumbnails: Array<{ pageNumber: number; dataUrl: string }>;
}

export type PresentationPreviewErrorCode =
  | 'invalid-file-type'
  | 'file-too-large'
  | 'password-required'
  | 'invalid-pdf'
  | 'empty-pdf'
  | 'page-render-failed'
  | 'canvas-failed'
  | 'superseded';

const previewErrorMessages: Record<PresentationPreviewErrorCode, string> = {
  'invalid-file-type': 'Choose a PDF file',
  'file-too-large': 'Choose a PDF no larger than 100 MB',
  'password-required': 'Password-protected PDFs cannot be previewed',
  'invalid-pdf': 'This PDF could not be previewed',
  'empty-pdf': 'This PDF does not contain any pages',
  'page-render-failed': 'A slide preview could not be rendered',
  'canvas-failed': 'Slide thumbnails could not be created',
  superseded: 'This preview was replaced by a newer selection',
};

export class PresentationPreviewError extends Error {
  constructor(readonly code: PresentationPreviewErrorCode) {
    super(previewErrorMessages[code]);
    this.name = 'PresentationPreviewError';
  }
}

export interface PresentationCanvas {
  width: number;
  height: number;
  getContext(contextId: '2d'): CanvasRenderingContext2D | null;
  toDataURL(type?: string): string;
}

export interface PresentationPdfRenderTask {
  promise: Promise<unknown>;
  cancel(): void;
}

export interface PresentationPdfPage {
  getViewport(options: { scale: number }): { width: number; height: number };
  render(options: {
    canvasContext: CanvasRenderingContext2D;
    viewport: { width: number; height: number };
  }): PresentationPdfRenderTask;
  cleanup(): unknown;
}

export interface PresentationPdfDocument {
  numPages: number;
  getPage(pageNumber: number): Promise<PresentationPdfPage>;
  destroy(): Promise<unknown>;
}

export interface PresentationPdfLoadingTask {
  promise: Promise<PresentationPdfDocument>;
  destroy(): Promise<unknown>;
  onPassword: ((updatePassword: (password: string) => void, reason: number) => void) | null;
}

export interface PresentationPreviewDependencies {
  loadPdf(data: ArrayBuffer): PresentationPdfLoadingTask;
  canvasFactory(width: number, height: number): PresentationCanvas;
}

interface PageResources {
  page: PresentationPdfPage;
  canvas?: PresentationCanvas;
  renderTask?: PresentationPdfRenderTask;
  release?: Promise<void>;
}

interface PreviewGeneration {
  cancelled: boolean;
  loadingTask?: PresentationPdfLoadingTask;
  document?: PresentationPdfDocument;
  page?: PageResources;
  releaseChain?: Promise<void>;
}

/**
 * Creates a browser-local convenience preview. A `.pdf` suffix is accepted
 * case-insensitively; the server remains authoritative for file and page
 * validation after upload.
 */
export function createPresentationPreviewer(
  dependencies: PresentationPreviewDependencies,
): (file: File) => Promise<PresentationPreview> {
  let active: PreviewGeneration | undefined;

  return async (file: File): Promise<PresentationPreview> => {
    const previous = active;
    if (previous) {
      previous.cancelled = true;
      void releaseGeneration(previous);
    }

    const owner: PreviewGeneration = { cancelled: false };
    active = owner;
    let completedPreview: PresentationPreview | undefined;
    try {
      if (!/\.pdf$/i.test(file.name)) throw new PresentationPreviewError('invalid-file-type');
      if (file.size > MAX_PREVIEW_BYTES) throw new PresentationPreviewError('file-too-large');
      ensureCurrent(owner, active);

      let data: ArrayBuffer;
      try {
        data = await file.arrayBuffer();
      } catch {
        throw new PresentationPreviewError('invalid-pdf');
      }
      ensureCurrent(owner, active);

      let loadingTask: PresentationPdfLoadingTask;
      try {
        loadingTask = dependencies.loadPdf(data);
      } catch {
        throw new PresentationPreviewError('invalid-pdf');
      }
      owner.loadingTask = loadingTask;
      let rejectPassword!: () => void;
      const passwordRequired = new Promise<never>((_resolve, reject) => {
        rejectPassword = () => reject(new PresentationPreviewError('password-required'));
      });
      loadingTask.onPassword = () => rejectPassword();

      let document: PresentationPdfDocument;
      try {
        document = await Promise.race([loadingTask.promise, passwordRequired]);
      } catch (error) {
        if (error instanceof PresentationPreviewError) throw error;
        if (isPasswordFailure(error)) throw new PresentationPreviewError('password-required');
        throw new PresentationPreviewError('invalid-pdf');
      }
      owner.document = document;
      ensureCurrent(owner, active);

      const pageCount = document.numPages;
      if (!Number.isSafeInteger(pageCount) || pageCount < 1) {
        throw new PresentationPreviewError('empty-pdf');
      }

      const thumbnails: PresentationPreview['thumbnails'] = [];
      let allocatedPixelArea = 0;
      for (let pageNumber = 1; pageNumber <= Math.min(pageCount, MAX_THUMBNAILS); pageNumber += 1) {
        ensureCurrent(owner, active);
        let page: PresentationPdfPage;
        try {
          page = await document.getPage(pageNumber);
        } catch {
          throw new PresentationPreviewError('page-render-failed');
        }
        const resources: PageResources = { page };
        owner.page = resources;
        try {
          ensureCurrent(owner, active);
          let baseViewport: { width: number; height: number };
          try {
            baseViewport = page.getViewport({ scale: 1 });
          } catch {
            throw new PresentationPreviewError('page-render-failed');
          }
          if (
            !Number.isFinite(baseViewport.width)
            || baseViewport.width <= 0
            || !Number.isFinite(baseViewport.height)
            || baseViewport.height <= 0
          ) {
            throw new PresentationPreviewError('page-render-failed');
          }
          const scale = Math.min(
            1,
            MAX_THUMBNAIL_WIDTH / baseViewport.width,
            MAX_THUMBNAIL_HEIGHT / baseViewport.height,
          );
          let viewport: { width: number; height: number };
          try {
            viewport = page.getViewport({ scale });
          } catch {
            throw new PresentationPreviewError('page-render-failed');
          }
          if (
            !Number.isFinite(viewport.width)
            || viewport.width <= 0
            || !Number.isFinite(viewport.height)
            || viewport.height <= 0
          ) {
            throw new PresentationPreviewError('page-render-failed');
          }
          const width = Math.max(1, Math.min(MAX_THUMBNAIL_WIDTH, Math.round(viewport.width)));
          const height = Math.max(1, Math.min(MAX_THUMBNAIL_HEIGHT, Math.round(viewport.height)));
          const pixelArea = width * height;
          if (
            !Number.isSafeInteger(pixelArea)
            || pixelArea < 1
            || allocatedPixelArea > MAX_PREVIEW_PIXEL_AREA - pixelArea
          ) {
            throw new PresentationPreviewError('page-render-failed');
          }
          allocatedPixelArea += pixelArea;

          let canvas: PresentationCanvas;
          try {
            canvas = dependencies.canvasFactory(width, height);
            resources.canvas = canvas;
            canvas.width = width;
            canvas.height = height;
          } catch {
            throw new PresentationPreviewError('canvas-failed');
          }
          let context: CanvasRenderingContext2D | null;
          try {
            context = canvas.getContext('2d');
          } catch {
            throw new PresentationPreviewError('canvas-failed');
          }
          if (!context) throw new PresentationPreviewError('canvas-failed');

          let renderTask: PresentationPdfRenderTask;
          try {
            renderTask = page.render({ canvasContext: context, viewport });
          } catch {
            throw new PresentationPreviewError('page-render-failed');
          }
          resources.renderTask = renderTask;
          try {
            await renderTask.promise;
          } catch {
            ensureCurrent(owner, active);
            throw new PresentationPreviewError('page-render-failed');
          }
          ensureCurrent(owner, active);

          let dataUrl: string;
          try {
            dataUrl = canvas.toDataURL('image/png');
          } catch {
            throw new PresentationPreviewError('canvas-failed');
          }
          thumbnails.push({ pageNumber, dataUrl });
        } finally {
          await releasePage(owner, resources, false);
        }
      }

      ensureCurrent(owner, active);
      completedPreview = { pageCount, thumbnails };
    } catch (error) {
      if (owner.cancelled || active !== owner) {
        throw new PresentationPreviewError('superseded');
      }
      if (error instanceof PresentationPreviewError) throw error;
      throw new PresentationPreviewError('invalid-pdf');
    } finally {
      let cleanupFailed = false;
      try {
        await releaseGeneration(owner);
      } catch {
        cleanupFailed = true;
      }
      const superseded = owner.cancelled || active !== owner;
      if (active === owner) active = undefined;
      if (superseded) throw new PresentationPreviewError('superseded');
      if (cleanupFailed) throw new PresentationPreviewError('invalid-pdf');
    }
    if (!completedPreview) throw new PresentationPreviewError('invalid-pdf');
    return completedPreview;
  };
}

function ensureCurrent(owner: PreviewGeneration, active: PreviewGeneration | undefined): void {
  if (owner.cancelled || active !== owner) throw new PresentationPreviewError('superseded');
}

async function releasePage(
  owner: PreviewGeneration,
  resources: PageResources,
  cancelRender: boolean,
): Promise<void> {
  if (!resources.release) {
    resources.release = (async () => {
      if (cancelRender && resources.renderTask) {
        try {
          resources.renderTask.cancel();
        } catch {
          // Resource cleanup is best-effort and never exposes provider details.
        }
      }
      if (resources.renderTask) await resources.renderTask.promise.catch(() => undefined);
      try {
        resources.page.cleanup();
      } catch {
        // PDF.js cleanup errors are private and the document is still destroyed.
      }
      if (resources.canvas) {
        resources.canvas.width = 0;
        resources.canvas.height = 0;
      }
      if (owner.page === resources) owner.page = undefined;
    })();
  }
  await resources.release;
}

async function releaseGeneration(owner: PreviewGeneration): Promise<void> {
  const prior = owner.releaseChain ?? Promise.resolve();
  const release = prior.then(async () => {
    const page = owner.page;
    if (page) await releasePage(owner, page, true);

    const document = owner.document;
    owner.document = undefined;
    if (document) {
      owner.loadingTask = undefined;
      await document.destroy().catch(() => undefined);
      return;
    }

    const loadingTask = owner.loadingTask;
    owner.loadingTask = undefined;
    if (loadingTask) await loadingTask.destroy().catch(() => undefined);
  });
  owner.releaseChain = release;
  await release;
}

function isPasswordFailure(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { name?: unknown }).name === 'PasswordException';
}

const defaultPreviewer = createPresentationPreviewer({
  loadPdf(data) {
    return getDocument({ data: new Uint8Array(data) }) as unknown as PresentationPdfLoadingTask;
  },
  canvasFactory(width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  },
});

export function previewPresentation(file: File): Promise<PresentationPreview> {
  return defaultPreviewer(file);
}
