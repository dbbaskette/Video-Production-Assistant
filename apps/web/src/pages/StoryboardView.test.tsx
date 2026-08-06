import { act, useEffect } from 'react';
import { MemoryRouter, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { presentationsApi, storyboardApi } from '../lib/api.js';
import { flushPromises, renderComponent } from '../components/component-test-utils.js';
import {
  StoryboardView,
  normalizeStoryboardSearch,
  removePresentationSearch,
} from './StoryboardView.js';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const PRESENTATION_ID = '22222222-2222-4222-8222-222222222222';
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
vi.mock('../components/PresentationImportDialog.js', () => ({
  PresentationImportDialog: ({ onAccepted }: { onAccepted(job: typeof PROCESSING): void }) => (
    <button onClick={() => onAccepted(PROCESSING)}>Accept presentation</button>
  ),
}));
vi.mock('../components/PresentationProgress.js', () => ({
  PresentationProgress: ({ initialJob, onTerminal, onClose }: {
    initialJob: typeof PROCESSING;
    onTerminal?(job: typeof PROCESSING): void;
    onClose(): void;
  }) => {
    useEffect(() => {
      if (initialJob.status !== 'processing') onTerminal?.(initialJob);
    }, [initialJob, onTerminal]);
    return <div>Progress {initialJob.id}<button onClick={onClose}>Close progress</button></div>;
  },
}));

function Location() {
  const location = useLocation();
  return <output aria-label="Location">{location.search}</output>;
}

function renderStoryboard(entry: string) {
  return renderComponent(
    <MemoryRouter
      initialEntries={[entry]}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <Routes>
        <Route path="/project/:projectId" element={<Outlet context={{ project }} />}>
          <Route path="storyboard" element={<><StoryboardView /><Location /></>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('Storyboard presentation integration', () => {
  beforeEach(() => {
    vi.spyOn(storyboardApi, 'get').mockResolvedValue(storyboard);
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
    expect([...view.container.querySelectorAll('button')].filter((candidate) => candidate.textContent === 'Accept presentation')).toHaveLength(1);
    act(() => view.container.querySelector<HTMLButtonElement>('button') &&
      [...view.container.querySelectorAll('button')].find((candidate) => candidate.textContent === 'Accept presentation')!.click());
    expect(view.container.textContent).toContain(`Progress ${PRESENTATION_ID}`);
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
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });
    const add = [...view.container.querySelectorAll('button')]
      .find((candidate) => candidate.textContent === 'Add presentation')!;
    act(() => add.click());
    expect([...view.container.querySelectorAll('button')]
      .filter((candidate) => candidate.textContent === 'Accept presentation')).toHaveLength(1);
    view.unmount();
  });
});
