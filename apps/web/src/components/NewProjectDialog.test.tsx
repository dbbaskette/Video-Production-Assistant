import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, brandsApi, presentationsApi, sourceDocsApi, type SourceDoc } from '../lib/api.js';
import { chooseFile, flushPromises, renderComponent } from './component-test-utils.js';
import { NewProjectDialog } from './NewProjectDialog.js';

const previewMock = vi.hoisted(() => vi.fn());
vi.mock('../lib/presentation-preview.js', () => ({
  PresentationPreviewError: class extends Error {},
  previewPresentation: previewMock,
  startPresentationPreview: (file: File) => ({ promise: previewMock(file), cancel: vi.fn() }),
}));
vi.mock('./BrandPicker.js', () => ({ BrandPicker: () => <div aria-label="Brand picker" /> }));

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const PRESENTATION_ID = '22222222-2222-4222-8222-222222222222';
const project = {
  id: PROJECT_ID,
  name: 'launch-deck',
  path: '/projects/launch-deck',
  created: '2026-08-05T12:00:00.000Z',
  brand: null,
  model_routing: {},
};
const job = {
  schema_version: 1 as const, id: PRESENTATION_ID, project_id: PROJECT_ID,
  filename: 'deck.pdf', status: 'processing' as const, stage: 'processing-slides' as const,
  generate_narration: true, page_count: 3, processed_pages: 0, analyzed_pages: 0,
  scripted_pages: 0, remaining_scene_count: 0, deterministic_commit: 'uncommitted' as const,
  created_at: '2026-08-05T12:00:00.000Z', updated_at: '2026-08-05T12:00:00.000Z',
};

function changeValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const result = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent === label);
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
}

describe('NewProjectDialog presentation mode', () => {
  beforeEach(() => {
    previewMock.mockReset().mockResolvedValue({ pageCount: 3, thumbnails: [] });
    vi.spyOn(api, 'getDefaults').mockResolvedValue({ projectsDefault: '/projects' });
    vi.spyOn(brandsApi, 'list').mockResolvedValue({ brands: [], default_brand_id: null });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('gates creation on a valid preview and accepts upload immediately', async () => {
    const create = vi.spyOn(api, 'createProject').mockResolvedValue(project);
    const upload = vi.spyOn(presentationsApi, 'upload').mockResolvedValue(job);
    const onCreated = vi.fn();
    const onClose = vi.fn();
    const view = renderComponent(
      <NewProjectDialog open mode="presentation" onCreated={onCreated} onClose={onClose} />,
    );
    expect(view.container.textContent).toContain('Create a narrated presentation');
    expect(view.container.textContent).toContain('Upload a PDF deck. VPA creates one scene per slide and can draft narration for each one.');
    expect(view.container.textContent).not.toContain('Reference docs');
    const createButton = button(view.container, 'Create & import presentation');
    changeValue(view.container.querySelector<HTMLInputElement>('input[placeholder="MCP Demo Test"]')!, 'launch deck');
    expect(createButton.disabled).toBe(true);
    chooseFile(view.container.querySelector('input[type="file"]')!, new File(['pdf'], 'deck.pdf'));
    await flushPromises();
    expect(createButton.disabled).toBe(false);
    act(() => { createButton.click(); createButton.click(); });
    await flushPromises();

    expect(create).toHaveBeenCalledOnce();
    expect(upload).toHaveBeenCalledOnce();
    expect(onCreated).toHaveBeenCalledWith(PROJECT_ID, { presentationId: PRESENTATION_ID });
    expect(onClose).toHaveBeenCalledOnce();
    view.unmount();
  });

  it('retries upload against the stored project without creating another project', async () => {
    const create = vi.spyOn(api, 'createProject').mockResolvedValue(project);
    const upload = vi.spyOn(presentationsApi, 'upload')
      .mockRejectedValueOnce(new Error('private upload failure'))
      .mockResolvedValueOnce(job);
    const onCreated = vi.fn();
    const view = renderComponent(
      <NewProjectDialog open mode="presentation" onCreated={onCreated} onClose={vi.fn()} />,
    );
    changeValue(view.container.querySelector<HTMLInputElement>('input[placeholder="MCP Demo Test"]')!, 'launch deck');
    chooseFile(view.container.querySelector('input[type="file"]')!, new File(['pdf'], 'deck.pdf'));
    await flushPromises();
    act(() => button(view.container, 'Create & import presentation').click());
    await flushPromises();
    expect(view.container.textContent).toContain('The PDF could not be uploaded');
    expect(view.container.textContent).not.toContain('private upload failure');

    act(() => button(view.container, 'Try upload again').click());
    await flushPromises();
    expect(create).toHaveBeenCalledOnce();
    expect(upload).toHaveBeenCalledTimes(2);
    expect(onCreated).toHaveBeenCalledWith(PROJECT_ID, { presentationId: PRESENTATION_ID });
    view.unmount();
  });

  it('opens the created empty project after upload failure', async () => {
    vi.spyOn(api, 'createProject').mockResolvedValue(project);
    vi.spyOn(presentationsApi, 'upload').mockRejectedValue(new Error('upload failed'));
    const onCreated = vi.fn();
    const onClose = vi.fn();
    const view = renderComponent(
      <NewProjectDialog open mode="presentation" onCreated={onCreated} onClose={onClose} />,
    );
    changeValue(view.container.querySelector<HTMLInputElement>('input[placeholder="MCP Demo Test"]')!, 'launch deck');
    chooseFile(view.container.querySelector('input[type="file"]')!, new File(['pdf'], 'deck.pdf'));
    await flushPromises();
    act(() => button(view.container, 'Create & import presentation').click());
    await flushPromises();
    act(() => button(view.container, 'Open empty project').click());
    expect(onCreated).toHaveBeenCalledWith(PROJECT_ID);
    expect(onClose).toHaveBeenCalledOnce();
    view.unmount();
  });

  it('keeps existing modes backward-compatible', () => {
    const ideate = renderComponent(<NewProjectDialog open mode="ideate" onCreated={vi.fn()} onClose={vi.fn()} />);
    expect(ideate.container.textContent).toContain('Ideate a new demo');
    expect(ideate.container.textContent).toContain('Reference docs');
    ideate.unmount();
    const recordings = renderComponent(<NewProjectDialog open mode="recordings" onCreated={vi.fn()} onClose={vi.fn()} />);
    expect(recordings.container.textContent).toContain('New project from recordings');
    expect(recordings.container.textContent).toContain('Reference docs');
    recordings.unmount();
  });

  it('guards a selected deck from accidental close and recovers from create failure without uploading', async () => {
    const create = vi.spyOn(api, 'createProject').mockRejectedValue(new Error('Project could not be created'));
    const upload = vi.spyOn(presentationsApi, 'upload');
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const onClose = vi.fn();
    const view = renderComponent(
      <NewProjectDialog open mode="presentation" onCreated={vi.fn()} onClose={onClose} />,
    );
    changeValue(view.container.querySelector<HTMLInputElement>('input[placeholder="MCP Demo Test"]')!, 'launch deck');
    chooseFile(view.container.querySelector('input[type="file"]')!, new File(['pdf'], 'deck.pdf'));
    await flushPromises();
    act(() => button(view.container, 'Cancel').click());
    expect(confirm).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();

    act(() => button(view.container, 'Create & import presentation').click());
    await flushPromises();
    expect(view.container.textContent).toContain('Project could not be created');
    expect(create).toHaveBeenCalledOnce();
    expect(upload).not.toHaveBeenCalled();
    view.unmount();
  });

  it('ignores delayed create completion after close and reopen starts a clean session', async () => {
    let resolveCreate!: (value: typeof project) => void;
    vi.spyOn(api, 'createProject').mockImplementation(() => new Promise((resolve) => { resolveCreate = resolve; }));
    const upload = vi.spyOn(presentationsApi, 'upload');
    const onCreated = vi.fn();
    const onClose = vi.fn();
    const props = { mode: 'presentation' as const, onCreated, onClose };
    const view = renderComponent(<NewProjectDialog {...props} open />);
    changeValue(view.container.querySelector<HTMLInputElement>('input[placeholder="MCP Demo Test"]')!, 'launch deck');
    chooseFile(view.container.querySelector('input[type="file"]')!, new File(['pdf'], 'deck.pdf'));
    await flushPromises();
    act(() => button(view.container, 'Create & import presentation').click());

    view.rerender(<NewProjectDialog {...props} open={false} />);
    view.rerender(<NewProjectDialog {...props} open />);
    resolveCreate(project);
    await flushPromises();

    expect(upload).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
    expect(view.container.querySelector<HTMLInputElement>('input[placeholder="MCP Demo Test"]')?.value).toBe('');
    expect(button(view.container, 'Create & import presentation').disabled).toBe(true);
    view.unmount();
  });

  it('ignores delayed upload completion after close and reopen', async () => {
    let resolveUpload!: (value: typeof job) => void;
    vi.spyOn(api, 'createProject').mockResolvedValue(project);
    vi.spyOn(presentationsApi, 'upload').mockImplementation(() => new Promise((resolve) => { resolveUpload = resolve; }));
    const onCreated = vi.fn();
    const onClose = vi.fn();
    const props = { mode: 'presentation' as const, onCreated, onClose };
    const view = renderComponent(<NewProjectDialog {...props} open />);
    changeValue(view.container.querySelector<HTMLInputElement>('input[placeholder="MCP Demo Test"]')!, 'launch deck');
    chooseFile(view.container.querySelector('input[type="file"]')!, new File(['pdf'], 'deck.pdf'));
    await flushPromises();
    act(() => button(view.container, 'Create & import presentation').click());
    await vi.waitFor(() => expect(presentationsApi.upload).toHaveBeenCalledOnce());

    view.rerender(<NewProjectDialog {...props} open={false} />);
    view.rerender(<NewProjectDialog {...props} open />);
    resolveUpload(job);
    await flushPromises();

    expect(onCreated).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(view.container.textContent).toContain('Create a narrated presentation');
    view.unmount();
  });

  it('confirmed discard uses project-aware copy and clears the next session', async () => {
    vi.spyOn(api, 'createProject').mockResolvedValue(project);
    vi.spyOn(presentationsApi, 'upload').mockRejectedValue(new Error('upload failed'));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const onClose = vi.fn();
    const props = { mode: 'presentation' as const, onCreated: vi.fn(), onClose };
    const view = renderComponent(<NewProjectDialog {...props} open />);
    changeValue(view.container.querySelector<HTMLInputElement>('input[placeholder="MCP Demo Test"]')!, 'launch deck');
    chooseFile(view.container.querySelector('input[type="file"]')!, new File(['pdf'], 'deck.pdf'));
    await flushPromises();
    act(() => button(view.container, 'Create & import presentation').click());
    await flushPromises();
    act(() => button(view.container, 'Cancel').click());

    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/empty project.*remain/i));
    expect(onClose).toHaveBeenCalledOnce();
    view.rerender(<NewProjectDialog {...props} open={false} />);
    view.rerender(<NewProjectDialog {...props} open />);
    expect(view.container.querySelector<HTMLInputElement>('input[placeholder="MCP Demo Test"]')?.value).toBe('');
    expect(view.container.textContent).not.toContain('deck.pdf');
    view.unmount();
  });

  it('ignores an in-flight reference-doc poll from a closed dialog session', async () => {
    vi.useFakeTimers();
    try {
      const extracting: SourceDoc = {
        id: 'doc-1', kind: 'file', name: 'brief.pdf', extractedRel: 'brief.md',
        extractor: 'pdf-parse', extractedChars: 0, status: 'extracting',
        uploadedAt: '2026-08-05T12:00:00.000Z',
      };
      let resolveList!: (docs: SourceDoc[]) => void;
      vi.spyOn(api, 'createProject').mockResolvedValue(project);
      vi.spyOn(sourceDocsApi, 'uploadFiles').mockResolvedValue({ created: [extracting] });
      const list = vi.spyOn(sourceDocsApi, 'list').mockImplementation(() => (
        new Promise((resolve) => { resolveList = resolve; })
      ));
      const props = { mode: 'ideate' as const, onCreated: vi.fn(), onClose: vi.fn() };
      const view = renderComponent(<NewProjectDialog {...props} open />);
      changeValue(view.container.querySelector<HTMLInputElement>('input[placeholder="MCP Demo Test"]')!, 'with docs');
      chooseFile(view.container.querySelector<HTMLInputElement>('input[multiple]')!, new File(['pdf'], 'brief.pdf'));
      act(() => button(view.container, 'Create & start ideating').click());
      await flushPromises();
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(view.container.querySelectorAll('[role="dialog"]')).toHaveLength(1);
      expect(document.activeElement).toBe(view.container.querySelector('[role="dialog"]'));
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      expect(list).toHaveBeenCalledOnce();

      view.rerender(<NewProjectDialog {...props} open={false} />);
      view.rerender(<NewProjectDialog {...props} open />);
      await act(async () => {
        resolveList([{ ...extracting, name: 'old-session-result.pdf', status: 'ready' }]);
        await Promise.resolve();
      });

      expect(view.container.textContent).not.toContain('old-session-result.pdf');
      expect(view.container.querySelector<HTMLInputElement>('input[placeholder="MCP Demo Test"]')?.value).toBe('');
      view.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('restores the parent modal semantics after closing failed document setup', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(api, 'createProject').mockResolvedValue(project);
    vi.spyOn(sourceDocsApi, 'uploadFiles').mockRejectedValue(new Error('upload failed'));
    const view = renderComponent(
      <NewProjectDialog open mode="ideate" onCreated={vi.fn()} onClose={vi.fn()} />,
    );
    changeValue(view.container.querySelector<HTMLInputElement>('input[placeholder="MCP Demo Test"]')!, 'with docs');
    chooseFile(view.container.querySelector<HTMLInputElement>('input[multiple]')!, new File(['pdf'], 'brief.pdf'));
    act(() => button(view.container, 'Create & start ideating').click());
    await vi.waitFor(() => expect(view.container.textContent).toContain('Something went wrong'));
    expect(view.container.querySelectorAll('[role="dialog"]')).toHaveLength(1);

    act(() => button(view.container, 'Close').click());
    await vi.waitFor(() => expect(view.container.textContent).not.toContain('Something went wrong'));
    const parent = view.container.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(parent).not.toBeNull();
    expect(parent.getAttribute('aria-hidden')).toBeNull();
    expect(parent.hasAttribute('inert')).toBe(false);
    expect(parent.inert).not.toBe(true);
    await vi.waitFor(() => expect(document.activeElement)
      .toBe(view.container.querySelector('input[placeholder="MCP Demo Test"]')));
    view.unmount();
  });
});
