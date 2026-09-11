import { act, useState } from 'react';
import {
  MemoryRouter,
  Outlet,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useSearchParams,
} from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { presentationsApi, storyboardApi } from '../lib/api.js';
import { chooseFile, flushPromises, renderComponent } from '../components/component-test-utils.js';
import {
  StoryboardView,
  normalizeStoryboardAfterRemoval,
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
const workflowStoryboard = {
  ...storyboard,
  scenes: [
    {
      id: 'scene-desktop',
      name: 'Desktop setup',
      description: 'Open the project workspace',
      type: 'desktop' as const,
    },
    {
      id: 'scene-browser',
      name: 'Browser checkout',
      description: 'Complete checkout in the browser',
      type: 'browser' as const,
      recording: { source: 'recordings/browser.mp4' },
      narration: { script: 'Explain checkout.' },
    },
    {
      id: 'scene-terminal',
      name: 'Terminal deploy',
      description: 'Run the deploy command',
      type: 'terminal' as const,
      recording: { source: 'recordings/terminal.mp4' },
      narration: { script: 'Deploy it.', audio: 'narration/terminal.mp3' },
    },
    {
      id: 'scene-slide',
      name: 'Architecture slide',
      description: 'Show the system map',
      type: 'slide' as const,
      recording: { source: 'presentations/slide.png' },
      narration: {
        script: 'Show the map.',
        chunks: [{ index: 0, text: 'Show the map.', audio: 'narration/slide.mp3' }],
      },
    },
  ],
};

const presentationScene = (id: string, presentationId = PRESENTATION_ID) => ({
  id,
  name: id,
  description: '',
  type: 'slide' as const,
  presentation_source: {
    presentation_id: presentationId,
    page_number: 1,
    page_count: 2,
    image: `presentations/${presentationId}/pages/page-0001.png`,
    hold_duration_sec: 5,
  },
});

vi.mock('./ScenePage.js', () => ({ ScenePage: ({ sceneId }: { sceneId: string }) => <div>Scene {sceneId}</div> }));
const confirmMock = vi.hoisted(() => vi.fn());
vi.mock('../components/ui/UiProvider.js', () => ({ useUi: () => ({ confirm: confirmMock }) }));
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

function LeaveStoryboard() {
  const navigate = useNavigate();
  return <button type="button" onClick={() => navigate('..')}>Leave storyboard</button>;
}

function WorkspaceHarness() {
  const [focusMode, setFocusMode] = useState(false);
  return (
    <>
      {!focusMode && <nav className="project-sidebar" aria-label="Test project navigation" />}
      <Outlet context={{
        project,
        projectNavCollapsed: false,
        setProjectNavCollapsed: () => undefined,
        focusMode,
        setFocusMode,
      }} />
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
        <Route path="/project/:projectId" element={<WorkspaceHarness />}>
          <Route path="storyboard" element={<><StoryboardView /><Location /><SearchControls /><LeaveStoryboard /></>} />
          <Route index element={<div>Overview screen</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

async function waitForUi(assertion: () => void): Promise<void> {
  let failure: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await act(async () => {
      await Promise.resolve();
      if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(1);
      else await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    try {
      assertion();
      return;
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
}

describe('Storyboard presentation integration', () => {
  beforeEach(() => {
    confirmMock.mockReset().mockResolvedValue(false);
    previewMock.mockReset().mockResolvedValue({ pageCount: 2, thumbnails: [] });
    vi.spyOn(storyboardApi, 'get').mockResolvedValue(storyboard);
    vi.spyOn(presentationsApi, 'upload').mockResolvedValue(PROCESSING);
    vi.spyOn(presentationsApi, 'list').mockResolvedValue([]);
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

    const previous = [
      { id: 'before' },
      { id: 'removed-a' },
      { id: 'removed-b' },
      { id: 'after' },
    ];
    const next = [{ id: 'before' }, { id: 'after' }];
    expect(normalizeStoryboardAfterRemoval(
      new URLSearchParams('scene=removed-a&tab=narration&safe=1'),
      previous,
      next,
    ).toString()).toBe('scene=after&tab=narration&safe=1');
    expect(normalizeStoryboardAfterRemoval(
      new URLSearchParams('scene=before&tab=narration&safe=1'),
      previous,
      next,
    ).toString()).toBe('scene=before&tab=narration&safe=1');
  });

  it('keeps the real presentation ledger mounted through empty and populated storyboard states', async () => {
    vi.mocked(storyboardApi.get)
      .mockResolvedValueOnce(null as never)
      .mockResolvedValue(storyboard);
    vi.mocked(presentationsApi.list).mockResolvedValue([READY]);
    const view = renderStoryboard(`/project/${PROJECT_ID}/storyboard`);

    await waitForUi(() => expect(view.container.textContent).toContain('No storyboard yet'));
    await waitForUi(() => expect(view.container.textContent).toContain('deck.pdf'));
    expect(view.container.querySelectorAll('.presentation-imports')).toHaveLength(1);
    act(() => buttonByText(view.container, 'Add presentation').click());
    expect(view.container.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    view.unmount();
  });

  it('uses the refetched storyboard to select the next scene after deck removal and preserves URL context', async () => {
    const before = {
      ...storyboard,
      scenes: [
        presentationScene('slide-a'),
        { id: 'unrelated', name: 'Unrelated', description: '', type: 'browser' as const },
        presentationScene('slide-b'),
      ],
    };
    const after = { ...storyboard, scenes: [before.scenes[1]!] };
    vi.mocked(storyboardApi.get).mockResolvedValueOnce(before).mockResolvedValue(after);
    vi.mocked(presentationsApi.list).mockResolvedValueOnce([
      { ...READY, remaining_scene_count: 2 },
    ]).mockResolvedValue([]);
    vi.spyOn(presentationsApi, 'get').mockResolvedValue({ ...READY, remaining_scene_count: 2 });
    const remove = vi.spyOn(presentationsApi, 'remove').mockResolvedValue();
    const view = renderStoryboard(
      `/project/${PROJECT_ID}/storyboard?scene=slide-a&tab=narration&safe=1`,
    );

    await waitForUi(() => expect(view.container.textContent).toContain('Remove imported deck'));
    act(() => buttonByText(view.container, 'Remove imported deck').click());
    await waitForUi(() => expect(view.container.querySelector('[role="dialog"]')?.textContent)
      .toContain('2 remaining scenes will be deleted'));
    act(() => buttonByText(view.container.querySelector('[role="dialog"]')!, 'Remove imported deck').click());
    await waitForUi(() => expect(remove).toHaveBeenCalledOnce());
    await waitForUi(() => expect(view.container.querySelector('output')?.textContent).toContain('scene=unrelated'));
    const location = view.container.querySelector('output')?.textContent ?? '';
    expect(location).toContain('tab=narration');
    expect(location).toContain('safe=1');
    view.unmount();
  });

  it('keeps an explicit surviving selection after deck removal', async () => {
    const before = {
      ...storyboard,
      scenes: [
        presentationScene('slide-a'),
        { id: 'survivor', name: 'Survivor', description: '', type: 'browser' as const },
      ],
    };
    const after = { ...storyboard, scenes: [before.scenes[1]!] };
    vi.mocked(storyboardApi.get).mockResolvedValueOnce(before).mockResolvedValue(after);
    vi.mocked(presentationsApi.list).mockResolvedValueOnce([READY]).mockResolvedValue([]);
    vi.spyOn(presentationsApi, 'get').mockResolvedValue(READY);
    vi.spyOn(presentationsApi, 'remove').mockResolvedValue();
    const view = renderStoryboard(`/project/${PROJECT_ID}/storyboard?scene=survivor&tab=script`);

    await waitForUi(() => expect(view.container.textContent).toContain('Remove imported deck'));
    act(() => buttonByText(view.container, 'Remove imported deck').click());
    await waitForUi(() => expect(view.container.querySelector('[role="dialog"]')).not.toBeNull());
    act(() => buttonByText(view.container.querySelector('[role="dialog"]')!, 'Remove imported deck').click());
    await waitForUi(() => expect(view.container.querySelector('output')?.textContent).toContain('scene=survivor'));
    expect(view.container.querySelector('output')?.textContent).toContain('tab=script');
    view.unmount();
  });

  it('clears a potentially deleted selection when DELETE succeeds but fresh Storyboard acquisition fails', async () => {
    const before = {
      ...storyboard,
      scenes: [
        presentationScene('slide-a'),
        { id: 'survivor', name: 'Survivor', description: '', type: 'browser' as const },
      ],
    };
    vi.mocked(storyboardApi.get)
      .mockResolvedValueOnce(before)
      .mockRejectedValue(new Error('untrusted storyboard diagnostic'));
    vi.mocked(presentationsApi.list).mockResolvedValueOnce([READY]).mockResolvedValue([]);
    vi.spyOn(presentationsApi, 'get').mockResolvedValue(READY);
    vi.spyOn(presentationsApi, 'remove').mockResolvedValue();
    const view = renderStoryboard(
      `/project/${PROJECT_ID}/storyboard?scene=slide-a&tab=script&safe=1`,
    );

    await waitForUi(() => expect(view.container.textContent).toContain('Remove imported deck'));
    act(() => buttonByText(view.container, 'Remove imported deck').click());
    await waitForUi(() => expect(view.container.querySelector('[role="dialog"]')).not.toBeNull());
    act(() => buttonByText(view.container.querySelector('[role="dialog"]')!, 'Remove imported deck').click());

    await waitForUi(() => expect(view.container.textContent).toContain(
      'Presentation was removed, but current project details could not be refreshed',
    ));
    const location = view.container.querySelector('output')?.textContent ?? '';
    expect(location).not.toContain('scene=slide-a');
    expect(location).toContain('tab=script');
    expect(location).toContain('safe=1');
    view.unmount();
  });

  it('refetches the presentation count after deleting one imported scene', async () => {
    const before = {
      ...storyboard,
      scenes: [presentationScene('slide-a'), presentationScene('slide-b')],
    };
    const afterOne = { ...storyboard, scenes: [before.scenes[1]!] };
    vi.mocked(storyboardApi.get).mockResolvedValueOnce(before).mockResolvedValue(afterOne);
    vi.mocked(presentationsApi.list)
      .mockResolvedValueOnce([{ ...READY, remaining_scene_count: 2 }])
      .mockResolvedValue([{ ...READY, remaining_scene_count: 1 }]);
    vi.spyOn(storyboardApi, 'removeScene').mockResolvedValue(afterOne);
    vi.spyOn(presentationsApi, 'get').mockResolvedValue({ ...READY, remaining_scene_count: 1 });
    confirmMock.mockResolvedValue(true);
    const view = renderStoryboard(`/project/${PROJECT_ID}/storyboard?scene=slide-a&tab=recording`);

    await waitForUi(() => expect(view.container.textContent).toContain('2 scenes remain'));
    act(() => view.container.querySelector<HTMLButtonElement>('button[title="Remove"]')!.click());
    await waitForUi(() => expect(storyboardApi.removeScene).toHaveBeenCalledWith(PROJECT_ID, 'slide-a'));
    await waitForUi(() => expect(view.container.textContent).toContain('1 scene remains'));
    expect(view.container.textContent).toContain('deck.pdf');
    act(() => buttonByText(view.container, 'Remove imported deck').click());
    await waitForUi(() => expect(view.container.querySelector('[role="dialog"]')?.textContent)
      .toContain('1 remaining scene will be deleted'));
    view.unmount();
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
    await waitForUi(() => expect(view.container.textContent).toContain('No storyboard yet'));
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
    await waitForUi(() => expect(view.container.textContent).toContain('Processing slides'));

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
    await act(async () => {
      resolveB({ ...PROCESSING, id: PRESENTATION_B_ID });
      await Promise.resolve();
    });
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
      await waitForUi(() => expect(view.container.textContent).toContain('No storyboard yet'));
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
      await waitForUi(() => expect(view.container.textContent).toContain('Slide 1'));
      await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
      expect(get).toHaveBeenCalledOnce();
      view.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders scene selection as a real button with sibling action buttons', async () => {
    const view = renderStoryboard(`/project/${PROJECT_ID}/storyboard?scene=scene-one`);
    await waitForUi(() => expect(view.container.textContent).toContain('Slide 1'));
    const select = view.container.querySelector<HTMLButtonElement>('button[aria-label="Select scene Slide 1"]')!;
    expect(select).not.toBeNull();
    expect(select.closest('.scene-row')?.getAttribute('role')).toBeNull();
    for (const title of ['Move up', 'Move down', 'Rename', 'Remove']) {
      const action = view.container.querySelector<HTMLButtonElement>(`button[title="${title}"]`)!;
      expect(select.contains(action)).toBe(false);
    }
    view.unmount();
  });

  it('composes scene filters and pins a selected scene outside the results', async () => {
    vi.mocked(storyboardApi.get).mockResolvedValueOnce(workflowStoryboard);
    const view = renderStoryboard(
      `/project/${PROJECT_ID}/storyboard?scene=scene-terminal&tab=narration&safe=1`,
    );
    await waitForUi(() => expect(view.container.textContent).toContain('4 of 4 scenes'));

    changeValue(inputByLabel(view.container, 'Search scenes'), 'CHECKOUT');
    changeValue(selectByLabel(view.container, 'Scene type'), 'browser');
    changeValue(selectByLabel(view.container, 'Scene readiness'), 'needs-narration');

    expect(view.container.textContent).toContain('1 of 4 scenes');
    expect(view.container.textContent).toContain('Current scene — outside filters');
    expect(view.container.querySelectorAll('[aria-label="Select scene Terminal deploy"]')).toHaveLength(1);
    expect(view.container.querySelectorAll('[aria-label="Select scene Browser checkout"]')).toHaveLength(1);
    expect(view.container.querySelectorAll('.scene-row')).toHaveLength(2);
    expect(view.container.querySelector('output[aria-label="Location"]')?.textContent)
      .toContain('scene=scene-terminal');

    act(() => buttonByText(view.container, 'Reset').click());
    expect(view.container.textContent).toContain('4 of 4 scenes');
    expect(view.container.textContent).not.toContain('outside filters');
    view.unmount();
  });

  it('navigates displayed scenes by controls and brackets while preserving URL context', async () => {
    vi.mocked(storyboardApi.get).mockResolvedValueOnce(workflowStoryboard);
    const view = renderStoryboard(
      `/project/${PROJECT_ID}/storyboard?scene=scene-desktop&tab=script&safe=1`,
    );
    await waitForUi(() => expect(view.container.textContent).toContain('Scene 1 of 4'));

    expect(buttonByLabel(view.container, 'Previous scene').disabled).toBe(true);
    act(() => buttonByLabel(view.container, 'Next scene').click());
    let location = view.container.querySelector('output[aria-label="Location"]')?.textContent ?? '';
    expect(location).toContain('scene=scene-browser');
    expect(location).toContain('tab=script');
    expect(location).toContain('safe=1');

    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: ']', bubbles: true })));
    location = view.container.querySelector('output[aria-label="Location"]')?.textContent ?? '';
    expect(location).toContain('scene=scene-terminal');

    const search = inputByLabel(view.container, 'Search scenes');
    act(() => search.dispatchEvent(new KeyboardEvent('keydown', { key: '[', bubbles: true })));
    expect(view.container.querySelector('output[aria-label="Location"]')?.textContent)
      .toContain('scene=scene-terminal');
    view.unmount();
  });

  it('shows stable scene card regions and the sticky scene context', async () => {
    vi.mocked(storyboardApi.get).mockResolvedValueOnce(workflowStoryboard);
    const view = renderStoryboard(`/project/${PROJECT_ID}/storyboard?scene=scene-browser`);
    await waitForUi(() => expect(view.container.textContent).toContain('Scene 2 of 4'));

    const selected = view.container.querySelector('.scene-row--selected')!;
    expect(selected.querySelector('.scene-row__thumbnail')?.textContent).toContain('02');
    expect(selected.querySelector('.scene-row__title')?.textContent).toBe('Browser checkout');
    expect(selected.querySelectorAll('.scene-status')).toHaveLength(0);
    expect(selected.querySelector('.scene-row__summary')?.textContent).toBe('Script ready');
    expect(selected.querySelector('details')?.open).toBe(false);
    expect(selected.querySelector('.scene-row__actions')).not.toBeNull();
    expect(view.container.querySelector('.scene-context-bar')?.textContent).toContain('Browser checkout');
    expect(view.container.querySelector('.scene-context-bar')?.textContent).toContain('browser');
    view.unmount();
  });

  it('hides and restores both rails in session focus mode', async () => {
    vi.mocked(storyboardApi.get).mockResolvedValueOnce(workflowStoryboard);
    const view = renderStoryboard(`/project/${PROJECT_ID}/storyboard?scene=scene-browser`);
    await waitForUi(() => expect(buttonByLabel(view.container, 'Focus editor')).not.toBeNull());

    act(() => buttonByLabel(view.container, 'Focus editor').click());
    expect(view.container.querySelector('.project-sidebar')).toBeNull();
    expect(view.container.querySelector('.storyboard-rail')).toBeNull();
    expect(view.container.querySelector('.storyboard-layout--focused')).not.toBeNull();
    expect(view.container.querySelector('output[aria-label="Location"]')?.textContent)
      .toContain('scene=scene-browser');

    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(view.container.querySelector('.project-sidebar')).not.toBeNull();
    expect(view.container.querySelector('.storyboard-rail')).not.toBeNull();
    expect(view.container.querySelector('output[aria-label="Location"]')?.textContent)
      .toContain('scene=scene-browser');
    view.unmount();
  });

  it('exits focus mode when navigating to a sibling project page', async () => {
    vi.mocked(storyboardApi.get).mockResolvedValueOnce(workflowStoryboard);
    const view = renderStoryboard(`/project/${PROJECT_ID}/storyboard?scene=scene-browser`);
    await waitForUi(() => expect(buttonByLabel(view.container, 'Focus editor')).not.toBeNull());

    act(() => buttonByLabel(view.container, 'Focus editor').click());
    expect(view.container.querySelector('.project-sidebar')).toBeNull();

    act(() => buttonByText(view.container, 'Leave storyboard').click());
    await waitForUi(() => expect(view.container.textContent).toContain('Overview screen'));
    expect(view.container.querySelector('.project-sidebar')).not.toBeNull();
    view.unmount();
  });
});

function buttonByText(container: ParentNode, label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll('button')]
    .find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function buttonByLabel(container: ParentNode, label: string): HTMLButtonElement {
  const match = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function inputByLabel(container: ParentNode, label: string): HTMLInputElement {
  return container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
}

function selectByLabel(container: ParentNode, label: string): HTMLSelectElement {
  return container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
}

function changeValue(element: HTMLInputElement | HTMLSelectElement, value: string): void {
  const prototype = element instanceof HTMLSelectElement
    ? HTMLSelectElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  act(() => {
    setter?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
