import { act } from 'react';
import { MemoryRouter, Outlet, Route, Routes, useLocation, useSearchParams } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { presentationsApi, storyboardApi } from '../lib/api.js';
import { chooseFile, flushPromises, renderComponent } from '../components/component-test-utils.js';
import {
  StoryboardView,
  normalizeStoryboardSearch,
  removePresentationSearch,
} from './StoryboardView.js';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const PRESENTATION_ID = '22222222-2222-4222-8222-222222222222';
const PRESENTATION_B_ID = '33333333-3333-4333-8333-333333333333';
const project = { id: PROJECT_ID, name: 'demo', path: '/projects/demo', lastOpened: null };
const PROCESSING = {
  schema_version: 1 as const, id: PRESENTATION_ID, project_id: PROJECT_ID,
  filename: 'deck.pdf', status: 'processing' as const, stage: 'processing-slides' as const,
  generate_narration: true, page_count: 2, processed_pages: 0, analyzed_pages: 0,
  scripted_pages: 0, remaining_scene_count: 0, deterministic_commit: 'uncommitted' as const,
  created_at: '2026-08-05T12:00:00.000Z', updated_at: '2026-08-05T12:00:00.000Z',
};
const READY = { ...PROCESSING, status: 'ready' as const, stage: 'ready' as const, processed_pages: 2, deterministic_commit: 'committed' as const };
const storyboard = {
  schema_version: 1 as const,
  project: { id: PROJECT_ID, name: 'demo', created: '2026-08-05T12:00:00.000Z' },
  scenes: [{ id: 'scene-one', name: 'Slide 1', description: '', type: 'slide' as const }],
};

vi.mock('./ScenePage.js', () => ({ ScenePage: ({ sceneId }: { sceneId: string }) => <div>Scene {sceneId}</div> }));
vi.mock('../components/ui/UiProvider.js', () => ({ useUi: () => ({ confirm: vi.fn() }) }));
const previewMock = vi.hoisted(() => vi.fn());
vi.mock('../lib/presentation-preview.js', () => ({
  PresentationPreviewError: class extends Error {},
  previewPresentation: previewMock,
  startPresentationPreview: (file: File) => ({ promise: previewMock(file), cancel: vi.fn() }),
}));

function Location() {
  const location = useLocation();
  return <output aria-label="Location">{location.search}</output>;
}

function SearchControls() {
  const [, setSearch] = useSearchParams();
  return (
    <>
      <button type="button" onClick={() => setSearch({ presentation: PRESENTATION_B_ID })}>Show B</button>
      <button type="button" onClick={() => setSearch({ presentation: 'not-a-presentation' })}>Show invalid</button>
      <button type="button" onClick={() => setSearch({ presentation: '' })}>Show empty ID</button>
    </>
  );
}

function renderStoryboard(entry: string) {
  return renderComponent(
    <MemoryRouter
      initialEntries={[entry]}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <Routes>
        <Route path="/project/:projectId" element={<Outlet context={{ project }} />}>
          <Route path="storyboard" element={<><StoryboardView /><Location /><SearchControls /></>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('Storyboard presentation integration', () => {
  beforeEach(() => {
    previewMock.mockReset().mockResolvedValue({ pageCount: 2, thumbnails: [] });
    vi.spyOn(storyboardApi, 'get').mockResolvedValue(storyboard);
    vi.spyOn(presentationsApi, 'upload').mockResolvedValue(PROCESSING);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('preserves scene, tab, and unknown parameters when presentation is removed or scenes normalize', () => {
    const removed = removePresentationSearch(new URLSearchParams('scene=s1&presentation=deck&tab=narration&safe=1'));
    expect(removed.toString()).toBe('scene=s1&tab=narration&safe=1');
    expect(normalizeStoryboardSearch(new URLSearchParams('tab=script'), 'first')?.toString()).toBe('tab=script&scene=first');
    expect(normalizeStoryboardSearch(new URLSearchParams('scene=explicit&tab=script'), 'first')).toBeNull();
  });

  it('opens one rail dialog and shows accepted progress without overriding explicit scene selection', async () => {
    const view = renderStoryboard(`/project/${PROJECT_ID}/storyboard?scene=scene-one&tab=narration`);
    await flushPromises();
    await flushPromises();
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });
    const add = [...view.container.querySelectorAll('button')]
      .find((candidate) => candidate.textContent === 'Add presentation');
    act(() => add!.click());
    expect(view.container.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    chooseFile(view.container.querySelector('input[type="file"]')!, new File(['pdf'], 'deck.pdf'));
    await flushPromises();
    act(() => view.container.querySelector<HTMLButtonElement>('.presentation-dialog button.primary')!.click());
    await flushPromises();
    expect(view.container.textContent).toContain('Processing slides');
    expect(view.container.querySelector('output')?.textContent).toContain('scene=scene-one');
    expect(view.container.querySelector('output')?.textContent).toContain('tab=narration');
    expect(view.container.querySelector('output')?.textContent).toContain(`presentation=${PRESENTATION_ID}`);
    view.unmount();
  });

  it('removes only presentation after terminal recovery and selects the first scene only when absent', async () => {
    vi.spyOn(presentationsApi, 'get').mockResolvedValue(READY);
    const view = renderStoryboard(
      `/project/${PROJECT_ID}/storyboard?presentation=${PRESENTATION_ID}&tab=script&safe=1`,
    );
    await flushPromises();
    await flushPromises();
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });
    await flushPromises();
    const location = view.container.querySelector('output')?.textContent ?? '';
    expect(location).not.toContain('presentation=');
    expect(location).toContain('scene=scene-one');
    expect(location).toContain('tab=script');
    expect(location).toContain('safe=1');
    view.unmount();
  });

  it('opens the same single import dialog from the empty storyboard entry point', async () => {
    vi.mocked(storyboardApi.get).mockResolvedValueOnce(null as never);
    const view = renderStoryboard(`/project/${PROJECT_ID}/storyboard`);
    await vi.waitFor(() => expect(view.container.textContent).toContain('No storyboard yet'));
    const add = [...view.container.querySelectorAll('button')]
      .find((candidate) => candidate.textContent === 'Add presentation')!;
    act(() => add.click());
    expect(view.container.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    view.unmount();
  });

  it('shows current-ID loading and never reuses A while B or an invalid ID owns the URL', async () => {
    let resolveA!: (value: typeof PROCESSING) => void;
    let resolveB!: (value: typeof PROCESSING) => void;
    const get = vi.spyOn(presentationsApi, 'get').mockImplementation((_projectId, id) => (
      new Promise((resolve) => {
        if (id === PRESENTATION_ID) resolveA = resolve;
        else resolveB = resolve;
      })
    ));
    const view = renderStoryboard(`/project/${PROJECT_ID}/storyboard?presentation=${PRESENTATION_ID}`);
    await flushPromises();
    expect(view.container.textContent).toContain('Loading presentation progress');
    act(() => resolveA(PROCESSING));
    await vi.waitFor(() => expect(view.container.textContent).toContain('Processing slides'));

    act(() => [...view.container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Show B')!.click());
    await flushPromises();
    expect(view.container.textContent).toContain('Loading presentation progress');
    expect(view.container.textContent).not.toContain('Processing slides');
    expect(get).toHaveBeenLastCalledWith(PROJECT_ID, PRESENTATION_B_ID);

    act(() => [...view.container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Show invalid')!.click());
    await flushPromises();
    expect(view.container.textContent).toContain('Presentation progress unavailable');
    expect(view.container.textContent).not.toContain('Processing slides');
    act(() => [...view.container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Show empty ID')!.click());
    await flushPromises();
    expect(view.container.textContent).toContain('Presentation progress unavailable');
    resolveB({ ...PROCESSING, id: PRESENTATION_B_ID });
    await flushPromises();
    expect(view.container.textContent).toContain('Presentation progress unavailable');
    view.unmount();
  });

  it('keeps one real progress owner through empty-to-populated refetch and polls once', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(storyboardApi.get)
        .mockResolvedValueOnce(null as never)
        .mockResolvedValue(storyboard);
      const get = vi.spyOn(presentationsApi, 'get').mockResolvedValue(READY);
      const view = renderStoryboard(`/project/${PROJECT_ID}/storyboard`);
      await vi.waitFor(() => expect(view.container.textContent).toContain('No storyboard yet'));
      act(() => [...view.container.querySelectorAll('button')]
        .find((button) => button.textContent === 'Add presentation')!.click());
      chooseFile(view.container.querySelector('input[type="file"]')!, new File(['pdf'], 'deck.pdf'));
      await flushPromises();
      act(() => view.container.querySelector<HTMLButtonElement>('.presentation-dialog button.primary')!.click());
      await flushPromises();

      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      await flushPromises();
      expect(get).toHaveBeenCalledOnce();
      expect(storyboardApi.get).toHaveBeenCalledTimes(2);
      expect(view.container.textContent).toContain('Presentation ready');
      await vi.waitFor(() => expect(view.container.textContent).toContain('Slide 1'));
      await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
      expect(get).toHaveBeenCalledOnce();
      view.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders scene selection as a real button with sibling action buttons', async () => {
    const view = renderStoryboard(`/project/${PROJECT_ID}/storyboard?scene=scene-one`);
    await vi.waitFor(() => expect(view.container.textContent).toContain('Slide 1'));
    const select = view.container.querySelector<HTMLButtonElement>('button[aria-label="Select scene Slide 1"]')!;
    expect(select).not.toBeNull();
    expect(select.closest('.scene-row')?.getAttribute('role')).toBeNull();
    for (const title of ['Move up', 'Move down', 'Rename', 'Remove']) {
      const action = view.container.querySelector<HTMLButtonElement>(`button[title="${title}"]`)!;
      expect(select.contains(action)).toBe(false);
    }
    view.unmount();
  });
});
