import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { presentationsApi } from '../lib/api.js';
import { chooseFile, flushPromises, renderComponent } from './component-test-utils.js';
import { PresentationImportDialog } from './PresentationImportDialog.js';

const previewMock = vi.hoisted(() => vi.fn());
vi.mock('../lib/presentation-preview.js', () => ({
  PresentationPreviewError: class extends Error {},
  previewPresentation: previewMock,
  startPresentationPreview: (file: File) => ({ promise: previewMock(file), cancel: vi.fn() }),
}));

const JOB = {
  schema_version: 1 as const,
  id: '22222222-2222-4222-8222-222222222222',
  project_id: '11111111-1111-4111-8111-111111111111',
  filename: 'deck.pdf',
  status: 'processing' as const,
  stage: 'processing-slides' as const,
  generate_narration: true,
  page_count: 4,
  processed_pages: 0,
  analyzed_pages: 0,
  scripted_pages: 0,
  remaining_scene_count: 0,
  deterministic_commit: 'uncommitted' as const,
  created_at: '2026-08-05T12:00:00.000Z',
  updated_at: '2026-08-05T12:00:00.000Z',
};

describe('PresentationImportDialog', () => {
  beforeEach(() => {
    previewMock.mockReset().mockResolvedValue({ pageCount: 4, thumbnails: [] });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('uploads once after a valid preview, accepts immediately, and closes', async () => {
    const upload = vi.spyOn(presentationsApi, 'upload').mockResolvedValue(JOB);
    const onAccepted = vi.fn();
    const onClose = vi.fn();
    const view = renderComponent(
      <PresentationImportDialog projectId={JOB.project_id} open onAccepted={onAccepted} onClose={onClose} />,
    );
    const submit = [...view.container.querySelectorAll('button')].find((button) => button.textContent === 'Add presentation')!;
    expect(submit.disabled).toBe(true);
    chooseFile(view.container.querySelector('input[type="file"]')!, new File(['pdf'], 'deck.pdf'));
    await flushPromises();
    expect(submit.disabled).toBe(false);
    act(() => { submit.click(); submit.click(); });
    await flushPromises();

    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledWith(
      JOB.project_id,
      expect.objectContaining({ name: 'deck.pdf' }),
      true,
      expect.objectContaining({ onProgress: expect.any(Function) }),
    );
    expect(onAccepted).toHaveBeenCalledOnce();
    expect(onAccepted).toHaveBeenCalledWith(JOB);
    expect(onClose).toHaveBeenCalledOnce();
    view.unmount();
  });

  it('stays open with bounded recovery copy after upload failure', async () => {
    vi.spyOn(presentationsApi, 'upload').mockRejectedValue(new Error('private server path /tmp/secret'));
    const onAccepted = vi.fn();
    const onClose = vi.fn();
    const view = renderComponent(
      <PresentationImportDialog projectId={JOB.project_id} open onAccepted={onAccepted} onClose={onClose} />,
    );
    chooseFile(view.container.querySelector('input[type="file"]')!, new File(['pdf'], 'deck.pdf'));
    await flushPromises();
    const submit = [...view.container.querySelectorAll('button')].find((button) => button.textContent === 'Add presentation')!;
    act(() => submit.click());
    await flushPromises();

    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('Try the upload again');
    expect(view.container.textContent).not.toContain('/tmp/secret');
    expect(onAccepted).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    view.unmount();
  });

  it('ignores upload completion after unmount without cancelling accepted work', async () => {
    let resolveUpload!: (value: typeof JOB) => void;
    const upload = vi.spyOn(presentationsApi, 'upload').mockImplementation(() => new Promise((resolve) => { resolveUpload = resolve; }));
    const onAccepted = vi.fn();
    const onClose = vi.fn();
    const view = renderComponent(
      <PresentationImportDialog projectId={JOB.project_id} open onAccepted={onAccepted} onClose={onClose} />,
    );
    chooseFile(view.container.querySelector('input[type="file"]')!, new File(['pdf'], 'deck.pdf'));
    await flushPromises();
    act(() => [...view.container.querySelectorAll('button')]
      .find((candidate) => candidate.textContent === 'Add presentation')!.click());
    expect(upload).toHaveBeenCalledOnce();
    view.unmount();
    resolveUpload(JOB);
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(onAccepted).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('traps focus, closes on safe Escape, and restores the opener', async () => {
    const opener = document.createElement('button');
    opener.textContent = 'Open presentation';
    document.body.append(opener);
    opener.focus();
    const onClose = vi.fn();
    const view = renderComponent(
      <PresentationImportDialog projectId={JOB.project_id} open onAccepted={vi.fn()} onClose={onClose} />,
    );
    await vi.waitFor(() => expect(document.activeElement?.textContent).toBe('Cancel'));
    const cancel = [...view.container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Cancel')!;
    const submit = [...view.container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Add presentation')!;
    submit.disabled = false;
    submit.focus();
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })));
    expect(document.activeElement).toBe(view.container.querySelector('input[type="file"]'));

    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(onClose).toHaveBeenCalledOnce();
    view.unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('ignores an old upload response after close and reopen creates a new dialog session', async () => {
    let resolveUpload!: (value: typeof JOB) => void;
    vi.spyOn(presentationsApi, 'upload').mockImplementation(() => new Promise((resolve) => { resolveUpload = resolve; }));
    const onAccepted = vi.fn();
    const onClose = vi.fn();
    const props = { projectId: JOB.project_id, onAccepted, onClose };
    const view = renderComponent(<PresentationImportDialog {...props} open />);
    chooseFile(view.container.querySelector('input[type="file"]')!, new File(['pdf'], 'deck.pdf'));
    await flushPromises();
    act(() => [...view.container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Add presentation')!.click());
    view.rerender(<PresentationImportDialog {...props} open={false} />);
    view.rerender(<PresentationImportDialog {...props} open />);
    resolveUpload(JOB);
    await flushPromises();

    expect(onAccepted).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(view.container.textContent).toContain('Add a presentation');
    view.unmount();
  });
});
