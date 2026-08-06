import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Scene } from '@vpa/shared';
import { jobsApi, narrationApi, ttsApi } from '../lib/api.js';
import { flushPromises, renderComponent } from './component-test-utils.js';
import { ProjectNarrationPanel } from './ProjectNarrationPanel.js';

const scenes: Scene[] = [
  { id: 'one', name: 'One', description: 'One', type: 'desktop', narration: { script: 'One.' } },
  { id: 'two', name: 'Two', description: 'Two', type: 'desktop' },
  {
    id: 'three',
    name: 'Three',
    description: 'Three',
    type: 'desktop',
    narration: { script: 'Three.', chunks: [{ index: 0, text: 'Three.', audio: 'three.mp3' }] },
  },
];

const engines = [
  { id: 'fake', displayName: 'Fake', voices: [{ id: 'alice', name: 'Alice' }], supportedEmotives: [], expressiveTags: [] },
  { id: 'gemini', displayName: 'Gemini', voices: [{ id: 'Kore', name: 'Kore' }, { id: 'Puck', name: 'Puck' }], supportedEmotives: [], expressiveTags: [] },
];

function select(container: HTMLElement, label: string): HTMLSelectElement {
  return container.querySelector(`select[aria-label="${label}"]`)!;
}

function setValue(element: HTMLSelectElement | HTMLInputElement, value: string) {
  const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')!.set!;
  act(() => {
    setter.call(element, value);
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function waitForUi(assertion: () => void): Promise<void> {
  let failure: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
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

describe('ProjectNarrationPanel', () => {
  beforeEach(() => {
    vi.spyOn(ttsApi, 'listEngines').mockResolvedValue(engines);
    vi.spyOn(jobsApi, 'list').mockResolvedValue({ jobs: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('selects the first real engine and resets voice when engine changes', async () => {
    const view = renderComponent(
      <ProjectNarrationPanel
        projectId="project-1"
        scenes={scenes}
        expressiveness="medium"
        expressivenessPending={false}
        onExpressivenessChange={vi.fn()}
      />,
    );
    await waitForUi(() => expect(select(view.container, 'Narration engine').value).toBe('gemini'));

    expect(select(view.container, 'Narration voice').value).toBe('Kore');
    setValue(select(view.container, 'Narration engine'), 'fake');
    expect(select(view.container, 'Narration voice').value).toBe('alice');
    expect(view.container.textContent).toContain('1 scene will be narrated');
    expect(view.container.textContent).toContain('1 existing narration preserved');
    view.unmount();
  });

  it('starts with exact options, reports completion, and never renders raw errors', async () => {
    const generate = vi.spyOn(narrationApi, 'generateProject').mockResolvedValue({ jobId: 'job-1', status: 'running' });
    let listener!: (event: { type: string; data?: unknown }) => void;
    vi.spyOn(jobsApi, 'stream').mockImplementation((_id, next) => { listener = next; return vi.fn(); });
    const view = renderComponent(
      <ProjectNarrationPanel
        projectId="project-1"
        scenes={scenes}
        expressiveness="heavy"
        expressivenessPending={false}
        onExpressivenessChange={vi.fn()}
      />,
    );
    await waitForUi(() => expect(select(view.container, 'Narration engine').value).toBe('gemini'));
    act(() => [...view.container.querySelectorAll('button')].find((button) => button.textContent === 'Narrate project')!.click());
    await flushPromises();

    expect(generate).toHaveBeenCalledWith('project-1', {
      engine: 'gemini', voice: 'Kore', speed: 1, expressiveness: 'heavy', overwrite: false,
    });
    act(() => listener({
      type: 'done',
      data: {
        totalScenes: 3, generatedScenes: 1, generatedChunks: 1, preservedScenes: 1,
        noScriptScenes: 1, removedScenes: 0, failedScenes: 0, cancelled: false,
        failures: [], providerError: '/private/key exploded',
      },
    }));
    expect(view.container.textContent).toContain('Narration complete');
    expect(view.container.textContent).not.toContain('/private/key');
    view.unmount();
  });

  it('recovers an active job and can cancel it', async () => {
    vi.mocked(jobsApi.list).mockResolvedValue({ jobs: [{
      id: '11111111-1111-4111-8111-111111111111',
      type: 'narration-generate-project',
      status: 'running',
      created: '2026-08-06',
      updated: '2026-08-06',
      events: [],
      meta: { projectId: 'project-1' },
    }] });
    vi.spyOn(jobsApi, 'stream').mockReturnValue(vi.fn());
    const cancel = vi.spyOn(narrationApi, 'cancelJob').mockResolvedValue({ cancelled: true });
    const generate = vi.spyOn(narrationApi, 'generateProject');
    const view = renderComponent(
      <ProjectNarrationPanel
        projectId="project-1"
        scenes={scenes}
        expressiveness="medium"
        expressivenessPending={false}
        onExpressivenessChange={vi.fn()}
      />,
    );
    await waitForUi(() => expect(view.container.textContent).toContain('Cancel'));
    const cancelButton = [...view.container.querySelectorAll('button')].find((button) => button.textContent === 'Cancel')!;
    act(() => cancelButton.click());
    await flushPromises();

    expect(cancel).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111');
    expect(generate).not.toHaveBeenCalled();
    view.unmount();
  });
});
