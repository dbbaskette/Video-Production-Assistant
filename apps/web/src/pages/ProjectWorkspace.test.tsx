import { act } from 'react';
import {
  MemoryRouter,
  Route,
  Routes,
  useOutletContext,
} from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, brandsApi } from '../lib/api.js';
import {
  WORKSPACE_PREFERENCE_KEY,
} from '../lib/workspace-preferences.js';
import { renderComponent } from '../components/component-test-utils.js';
import {
  ProjectWorkspace,
  type WorkspaceOutletContext,
} from './ProjectWorkspace.js';

vi.mock('../components/ProjectIssuesDrawer.js', () => ({
  ProjectIssuesControl: () => null,
}));

vi.mock('../lib/pipeline.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/pipeline.js')>();
  const labels = [
    ['storyboard', 'Storyboard'],
    ['recordings', 'Recordings'],
    ['script', 'Script'],
    ['narration', 'Narration'],
    ['lower-thirds', 'Lower Thirds'],
    ['render', 'Render'],
    ['review', 'Review'],
  ] as const;
  return {
    ...actual,
    usePipelineSteps: (projectId: string) => ({
      steps: labels.map(([key, label]) => ({
        key,
        label,
        to: `/project/${projectId}/${key}`,
        status: 'todo' as const,
        state: 'blocked' as const,
        detail: `${label} workspace`,
      })),
    }),
  };
});

const projectEntry = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Demo',
  path: '/Work/demo',
  lastOpened: '2026-08-01T12:00:00.000Z',
};

describe('ProjectWorkspace navigation layout', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', new (awaitStorage())());
    vi.spyOn(api, 'listProjects').mockResolvedValue({ projects: [projectEntry] });
    vi.spyOn(api, 'getProject').mockResolvedValue({
      ...projectEntry,
      created: '2026-08-01T12:00:00.000Z',
      brand: null,
      model_routing: {},
    });
    vi.spyOn(brandsApi, 'list').mockResolvedValue({ brands: [], default_brand_id: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('collapses without losing destinations and persists the preference', async () => {
    const view = renderWorkspace();
    await waitForUi(() => expect(buttonByLabel(view.container, 'Collapse project navigation')).not.toBeNull());

    act(() => buttonByLabel(view.container, 'Collapse project navigation')!.click());
    expect(buttonByLabel(view.container, 'Expand project navigation')).not.toBeNull();
    for (const label of ['Project', 'Scenes', 'Review & export', 'Source recordings', 'Full script', 'Batch narration', 'Text overview', 'Automated quality checks', 'Brand library', 'All projects']) {
      expect([...view.container.querySelectorAll('a')].some(a => a.textContent === label), label).toBe(true);
    }
    expect(JSON.parse(localStorage.getItem(WORKSPACE_PREFERENCE_KEY)!)).toEqual({
      projectNavCollapsed: true,
    });

    view.unmount();
    const reloaded = renderWorkspace();
    await waitForUi(() => expect(buttonByLabel(reloaded.container, 'Expand project navigation')).not.toBeNull());
    reloaded.unmount();
  });

  it('restores the prior compact state after session focus mode', async () => {
    localStorage.setItem(WORKSPACE_PREFERENCE_KEY, JSON.stringify({ projectNavCollapsed: true }));
    const view = renderWorkspace();
    await waitForUi(() => expect(buttonByLabel(view.container, 'Expand project navigation')).not.toBeNull());

    act(() => buttonByText(view.container, 'Enter focus').click());
    expect(view.container.querySelector('.project-sidebar')).toBeNull();
    expect(view.container.querySelector('.project-workspace--focused')).not.toBeNull();

    act(() => buttonByText(view.container, 'Exit focus').click());
    expect(buttonByLabel(view.container, 'Expand project navigation')).not.toBeNull();
    expect(localStorage.getItem(WORKSPACE_PREFERENCE_KEY)).toBe(
      JSON.stringify({ projectNavCollapsed: true }),
    );
    view.unmount();
  });
});

function FocusProbe() {
  const { focusMode, setFocusMode } = useOutletContext<WorkspaceOutletContext>();
  return (
    <button type="button" onClick={() => setFocusMode(!focusMode)}>
      {focusMode ? 'Exit focus' : 'Enter focus'}
    </button>
  );
}

function renderWorkspace() {
  return renderComponent(
    <MemoryRouter
      initialEntries={[`/project/${projectEntry.id}`]}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <Routes>
        <Route path="/project/:projectId" element={<ProjectWorkspace />}>
          <Route index element={<FocusProbe />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

function buttonByLabel(container: ParentNode, label: string): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
}

function buttonByText(container: ParentNode, label: string): HTMLButtonElement {
  return [...container.querySelectorAll('button')]
    .find((button) => button.textContent?.trim() === label)!;
}

async function waitForUi(assertion: () => void): Promise<void> {
  let failure: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await act(async () => { await Promise.resolve(); });
    try {
      assertion();
      return;
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
}

function awaitStorage() {
  return class {
    private values = new Map<string, string>();
    getItem(key: string) { return this.values.get(key) ?? null; }
    setItem(key: string, value: string) { this.values.set(key, value); }
    clear() { this.values.clear(); }
    removeItem(key: string) { this.values.delete(key); }
  };
}
