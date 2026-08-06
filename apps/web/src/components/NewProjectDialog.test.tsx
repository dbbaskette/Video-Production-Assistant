import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, brandsApi, presentationsApi } from '../lib/api.js';
import { chooseFile, flushPromises, renderComponent } from './component-test-utils.js';
import { NewProjectDialog } from './NewProjectDialog.js';

const previewMock = vi.hoisted(() => vi.fn());
vi.mock('../lib/presentation-preview.js', () => ({
  PresentationPreviewError: class extends Error {},
  previewPresentation: previewMock,
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
});
