import { act, StrictMode, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPresentationPreviewer,
  type PresentationCanvas,
  type PresentationPdfDocument,
  type PresentationPreview,
} from '../lib/presentation-preview.js';
import { chooseFile, flushPromises, renderComponent } from './component-test-utils.js';

vi.mock('pdfjs-dist', () => ({
  getDocument: vi.fn(),
  GlobalWorkerOptions: { workerSrc: '' },
}));

const previewMock = vi.fn();

import {
  PresentationFilePicker,
  formatFileSize,
  resolvePresentationPreview,
  type PresentationPreviewResult,
  type PresentationPreviewResultOperation,
} from './PresentationFilePicker.js';

const startPreviewMock = vi.fn<[File], PresentationPreviewResultOperation>();

function operation(result: PresentationPreviewResult): PresentationPreviewResultOperation {
  return { promise: Promise.resolve(result), cancel: vi.fn() };
}

function Harness({ onPreviewChange = vi.fn(), disabled = false, startPreview = startPreviewMock }: {
  onPreviewChange?: (state: { valid: boolean; preview: PresentationPreview | null }) => void;
  disabled?: boolean;
  startPreview?: (file: File) => PresentationPreviewResultOperation;
}) {
  const [file, setFile] = useState<File | null>(null);
  return (
    <PresentationFilePicker
      file={file}
      disabled={disabled}
      onChange={setFile}
      onPreviewChange={onPreviewChange}
      startPreview={startPreview}
    />
  );
}

describe('PresentationFilePicker', () => {
  beforeEach(() => {
    previewMock.mockReset();
    startPreviewMock.mockReset();
  });
  afterEach(() => { document.body.innerHTML = ''; });

  it('shows a contained four-slide contact sheet and continuation count', async () => {
    startPreviewMock.mockReturnValue(operation({
      kind: 'ready',
      preview: {
        pageCount: 7,
        thumbnails: Array.from({ length: 4 }, (_, index) => ({
          pageNumber: index + 1,
          dataUrl: `data:image/png;base64,${index + 1}`,
        })),
      },
    }));
    const view = renderComponent(<Harness />);
    chooseFile(view.container.querySelector('input[type="file"]')!, new File([new Uint8Array(1536)], 'roadmap.pdf'));
    await flushPromises();

    expect(view.container.textContent).toContain('roadmap.pdf');
    expect(view.container.textContent).toContain('1.5 KB');
    expect(view.container.textContent).toContain('7 slides');
    expect(view.container.textContent).toContain('+3 more slides');
    const images = [...view.container.querySelectorAll('img')];
    expect(images.map((image) => image.alt)).toEqual([
      'Slide preview 1', 'Slide preview 2', 'Slide preview 3', 'Slide preview 4',
    ]);
    expect(images.every((image) => image.classList.contains('presentation-contact-sheet__image'))).toBe(true);
    expect(view.container.textContent).toContain('01');
    expect(view.container.textContent).toContain('04');
    view.unmount();
  });

  it('ignores a stale preview after the file is replaced', async () => {
    let resolveOld!: (value: PresentationPreview) => void;
    startPreviewMock
      .mockImplementationOnce(() => ({
        promise: new Promise<PresentationPreviewResult>((resolve) => {
          resolveOld = (preview) => resolve({ kind: 'ready', preview });
        }),
        cancel: vi.fn(),
      }))
      .mockReturnValueOnce(operation({ kind: 'ready', preview: { pageCount: 2, thumbnails: [] } }));
    const onPreviewChange = vi.fn();
    const view = renderComponent(<Harness onPreviewChange={onPreviewChange} />);
    const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')!;
    chooseFile(input, new File(['old'], 'old.pdf'));
    chooseFile(input, new File(['new'], 'new.pdf'));
    await flushPromises();
    act(() => resolveOld({ pageCount: 99, thumbnails: [] }));
    await flushPromises();

    expect(view.container.textContent).toContain('new.pdf');
    expect(view.container.textContent).toContain('2 slides');
    expect(view.container.textContent).not.toContain('99 slides');
    expect(onPreviewChange).toHaveBeenLastCalledWith({
      valid: true,
      preview: { pageCount: 2, thumbnails: [] },
    });
    view.unmount();
  });

  it('keeps an invalid selection, alerts with replacement guidance, and removes once', async () => {
    startPreviewMock.mockReturnValue(operation({
      kind: 'error',
      message: 'This PDF could not be previewed',
    }));
    const onPreviewChange = vi.fn();
    const view = renderComponent(<Harness onPreviewChange={onPreviewChange} />);
    chooseFile(view.container.querySelector('input[type="file"]')!, new File(['broken'], 'broken.pdf'));
    await flushPromises();

    const alert = view.container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('This PDF could not be previewed');
    expect(alert?.textContent).toContain('replace');
    expect(view.container.textContent).toContain('broken.pdf');
    expect(onPreviewChange).toHaveBeenLastCalledWith({ valid: false, preview: null });

    const remove = view.container.querySelector<HTMLButtonElement>('button[aria-label="Remove broken.pdf"]')!;
    act(() => remove.click());
    expect(view.container.textContent).not.toContain('broken.pdf');
    expect(onPreviewChange).toHaveBeenLastCalledWith({ valid: false, preview: null });
    view.unmount();
  });

  it('keeps a visible, associated replacement control after selection', async () => {
    startPreviewMock.mockReturnValue(operation({ kind: 'ready', preview: { pageCount: 1, thumbnails: [] } }));
    const view = renderComponent(<Harness />);
    const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(input.getAttribute('aria-label')).toBe('Presentation PDF');
    chooseFile(input, new File(['deck'], 'deck.pdf'));
    await flushPromises();

    const replace = [...view.container.querySelectorAll('label')]
      .find((label) => label.textContent === 'Replace PDF')!;
    expect(replace.htmlFor).toBe(input.id);
    expect(replace.hidden).toBe(false);
    view.unmount();
  });

  it('cancels and releases real PDF preview resources when the picker unmounts', async () => {
    let rejectRender!: (error: unknown) => void;
    const renderPromise = new Promise<void>((_resolve, reject) => { rejectRender = reject; });
    const renderCancel = vi.fn(() => rejectRender(new Error('cancelled')));
    const pageCleanup = vi.fn();
    const documentDestroy = vi.fn(async () => undefined);
    const render = vi.fn(() => ({ promise: renderPromise, cancel: renderCancel }));
    const document: PresentationPdfDocument = {
      numPages: 1,
      getPage: vi.fn(async () => ({
        getViewport: ({ scale }: { scale: number }) => ({ width: 640 * scale, height: 480 * scale }),
        render,
        cleanup: pageCleanup,
      })),
      destroy: documentDestroy,
    };
    const previewer = createPresentationPreviewer({
      loadPdf: () => ({ promise: Promise.resolve(document), destroy: vi.fn(async () => undefined), onPassword: null }),
      canvasFactory: () => ({
        width: 0,
        height: 0,
        getContext: () => ({} as CanvasRenderingContext2D),
        toDataURL: () => 'data:image/png;base64,page',
      } satisfies PresentationCanvas),
    });
    const startPreview = (file: File): PresentationPreviewResultOperation => {
      const work = previewer.start(file);
      return {
        promise: work.promise.then(
          (preview) => ({ kind: 'ready' as const, preview }),
          () => ({ kind: 'superseded' as const }),
        ),
        cancel: work.cancel,
      };
    };
    const onPreviewChange = vi.fn();
    const view = renderComponent(<Harness startPreview={startPreview} onPreviewChange={onPreviewChange} />);
    const selected = new File(['deck'], 'deck.pdf');
    Object.defineProperty(selected, 'arrayBuffer', {
      value: vi.fn(async () => new Uint8Array([1, 2, 3]).buffer),
    });
    chooseFile(view.container.querySelector('input[type="file"]')!, selected);
    await vi.waitFor(() => expect(render).toHaveBeenCalledOnce());
    const callsAtUnmount = onPreviewChange.mock.calls.length;

    view.unmount();
    await vi.waitFor(() => expect(documentDestroy).toHaveBeenCalledOnce());
    expect(renderCancel).toHaveBeenCalledOnce();
    expect(pageCleanup).toHaveBeenCalledOnce();
    expect(onPreviewChange).toHaveBeenCalledTimes(callsAtUnmount);
  });

  it('disables native selection and removal controls', async () => {
    startPreviewMock.mockReturnValue(operation({ kind: 'ready', preview: { pageCount: 1, thumbnails: [] } }));
    const view = renderComponent(<Harness disabled />);
    const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(input.accept).toBe('.pdf');
    expect(input.disabled).toBe(true);
    expect(view.container.querySelector('label')?.getAttribute('aria-disabled')).toBe('true');
    view.unmount();
  });

  it('makes the selected-file replacement visibly inert while disabled and restores activation', async () => {
    startPreviewMock.mockReturnValue(operation({ kind: 'ready', preview: { pageCount: 1, thumbnails: [] } }));
    const view = renderComponent(<Harness />);
    const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')!;
    chooseFile(input, new File(['deck'], 'deck.pdf'));
    await flushPromises();

    view.rerender(<Harness disabled />);
    const replace = [...view.container.querySelectorAll('label')]
      .find((label) => label.textContent === 'Replace PDF')!;
    const inputClicks = vi.fn();
    input.addEventListener('click', inputClicks);
    expect(replace.getAttribute('aria-disabled')).toBe('true');
    expect(replace.classList.contains('is-disabled')).toBe(true);
    expect(input.disabled).toBe(true);
    expect(view.container.querySelector<HTMLButtonElement>('button[aria-label="Remove deck.pdf"]')?.disabled).toBe(true);
    act(() => {
      replace.click();
      replace.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      replace.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    });
    expect(inputClicks).not.toHaveBeenCalled();

    view.rerender(<Harness />);
    expect(replace.getAttribute('aria-disabled')).toBe('false');
    expect(replace.classList.contains('is-disabled')).toBe(false);
    expect(input.disabled).toBe(false);
    act(() => replace.click());
    expect(inputClicks).toHaveBeenCalledOnce();
    view.unmount();
  });

  it('does not emit a completed preview after unmount', async () => {
    startPreviewMock.mockReturnValue(operation({ kind: 'ready', preview: { pageCount: 3, thumbnails: [] } }));
    const onPreviewChange = vi.fn();
    const view = renderComponent(<Harness onPreviewChange={onPreviewChange} />);
    chooseFile(view.container.querySelector('input[type="file"]')!, new File(['deck'], 'deck.pdf'));
    const callsBeforeUnmount = onPreviewChange.mock.calls.length;
    view.unmount();
    await Promise.resolve();
    await Promise.resolve();
    expect(onPreviewChange).toHaveBeenCalledTimes(callsBeforeUnmount);
  });

  it('converts a rejected preview promise into bounded error copy', async () => {
    previewMock.mockRejectedValue(new Error('/private/provider/detail'));
    await expect(resolvePresentationPreview(new File(['bad'], 'bad.pdf'), previewMock))
      .resolves.toEqual({ kind: 'error', message: 'This PDF could not be previewed' });
  });

  it('formats byte, KB, and MB boundaries without misleading precision', () => {
    expect(formatFileSize(1023)).toBe('1023 B');
    expect(formatFileSize(1024)).toBe('1 KB');
    expect(formatFileSize(1024 * 1024)).toBe('1 MB');
    expect(formatFileSize(15.6 * 1024 * 1024)).toBe('16 MB');
  });

  it('still completes the current preview under React Strict Mode', async () => {
    startPreviewMock.mockReturnValue(operation({ kind: 'ready', preview: { pageCount: 2, thumbnails: [] } }));
    const onPreviewChange = vi.fn();
    const view = renderComponent(<StrictMode><Harness onPreviewChange={onPreviewChange} /></StrictMode>);
    chooseFile(view.container.querySelector('input[type="file"]')!, new File(['deck'], 'strict.pdf'));
    await flushPromises();
    expect(onPreviewChange).toHaveBeenLastCalledWith({
      valid: true,
      preview: { pageCount: 2, thumbnails: [] },
    });
    view.unmount();
  });
});
