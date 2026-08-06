import { act, StrictMode, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PresentationPreview } from '../lib/presentation-preview.js';
import { chooseFile, flushPromises, renderComponent } from './component-test-utils.js';

vi.mock('../lib/presentation-preview.js', () => ({
  PresentationPreviewError: class MockPresentationPreviewError extends Error {
    constructor(readonly code: string) { super(code); }
  },
  previewPresentation: vi.fn(),
}));

const previewMock = vi.fn();

import {
  PresentationFilePicker,
  formatFileSize,
  resolvePresentationPreview,
  type PresentationPreviewResult,
} from './PresentationFilePicker.js';

const resolvePreviewMock = vi.fn<[File], Promise<PresentationPreviewResult>>();

function Harness({ onPreviewChange = vi.fn(), disabled = false }: {
  onPreviewChange?: (state: { valid: boolean; preview: PresentationPreview | null }) => void;
  disabled?: boolean;
}) {
  const [file, setFile] = useState<File | null>(null);
  return (
    <PresentationFilePicker
      file={file}
      disabled={disabled}
      onChange={setFile}
      onPreviewChange={onPreviewChange}
      resolvePreview={resolvePreviewMock}
    />
  );
}

describe('PresentationFilePicker', () => {
  beforeEach(() => {
    previewMock.mockReset();
    resolvePreviewMock.mockReset();
  });
  afterEach(() => { document.body.innerHTML = ''; });

  it('shows a contained four-slide contact sheet and continuation count', async () => {
    resolvePreviewMock.mockResolvedValue({
      kind: 'ready',
      preview: {
        pageCount: 7,
        thumbnails: Array.from({ length: 4 }, (_, index) => ({
          pageNumber: index + 1,
          dataUrl: `data:image/png;base64,${index + 1}`,
        })),
      },
    });
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
    resolvePreviewMock
      .mockImplementationOnce(() => new Promise<PresentationPreviewResult>((resolve) => {
        resolveOld = (preview) => resolve({ kind: 'ready', preview });
      }))
      .mockResolvedValueOnce({ kind: 'ready', preview: { pageCount: 2, thumbnails: [] } });
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
    resolvePreviewMock.mockResolvedValue({
      kind: 'error',
      message: 'This PDF could not be previewed',
    });
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

  it('disables native selection and removal controls', async () => {
    resolvePreviewMock.mockResolvedValue({ kind: 'ready', preview: { pageCount: 1, thumbnails: [] } });
    const view = renderComponent(<Harness disabled />);
    const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(input.accept).toBe('.pdf');
    expect(input.disabled).toBe(true);
    expect(view.container.querySelector('label')?.getAttribute('aria-disabled')).toBe('true');
    view.unmount();
  });

  it('does not emit a completed preview after unmount', async () => {
    resolvePreviewMock.mockResolvedValue({ kind: 'ready', preview: { pageCount: 3, thumbnails: [] } });
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
    resolvePreviewMock.mockResolvedValue({ kind: 'ready', preview: { pageCount: 2, thumbnails: [] } });
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
