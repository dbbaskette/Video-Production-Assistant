import { act } from 'react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { storyboardApi } from '../lib/api.js';
import { renderComponent } from '../components/component-test-utils.js';
import { NarrationPage } from './NarrationPage.js';

const panel = vi.hoisted(() => vi.fn(() => <div data-testid="project-narration-panel">Project narration controls</div>));
vi.mock('../components/ProjectNarrationPanel.js', () => ({ ProjectNarrationPanel: panel }));

async function waitForUi(assertion: () => void): Promise<void> {
  let failure: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)));
    try {
      assertion();
      return;
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
}

describe('NarrationPage project controls', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    panel.mockClear();
    document.body.innerHTML = '';
  });

  it('renders one project panel while keeping scene links available', async () => {
    vi.spyOn(storyboardApi, 'get').mockResolvedValue({
      schema_version: 1,
      project: { id: 'project-1', name: 'Project', created: '2026-08-06' },
      scenes: [
        { id: 'scene-1', name: 'First scene', description: '', type: 'desktop', narration: { script: 'Hello.' } },
        { id: 'scene-2', name: 'Second scene', description: '', type: 'desktop' },
      ],
    });
    const project = { id: 'project-1', name: 'Project', path: '/projects/project', lastOpened: null };
    const view = renderComponent(
      <MemoryRouter initialEntries={['/project/project-1/narration']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Routes>
          <Route path="/project/:projectId" element={<Outlet context={{ project }} />}>
            <Route path="narration" element={<NarrationPage />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    await waitForUi(() => expect(view.container.textContent).toContain('Project narration controls'));
    expect(panel).toHaveBeenCalledTimes(1);
    expect(view.container.textContent).toContain('First scene');
    expect(view.container.textContent).toContain('Second scene');
    expect(view.container.querySelectorAll('a[href*="tab=Narration"]')).toHaveLength(2);
    view.unmount();
  });
});
