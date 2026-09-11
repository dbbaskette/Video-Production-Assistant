import { act } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Scene } from '@vpa/shared';
import { jobsApi, narrationApi, ttsApi, voiceApi } from '../lib/api.js';
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
    vi.spyOn(voiceApi, 'list').mockResolvedValue([{ id: 'preset', name: 'Narrator', engine: 'gemini', voice: 'Puck', speed: 1.2 }]);
    vi.spyOn(ttsApi, 'listEngines').mockResolvedValue(engines);
    vi.spyOn(jobsApi, 'list').mockResolvedValue({ jobs: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('selects the first real engine and resets voice when engine changes', async () => {
    const view = renderComponent(
      <MemoryRouter><ProjectNarrationPanel
        projectId="project-1"
        scenes={scenes}
        expressiveness="medium"
        expressivenessPending={false}
        onExpressivenessChange={vi.fn()}
      /></MemoryRouter>,
    );
    await waitForUi(() => expect(select(view.container, 'Narration engine').value).toBe('gemini'));

    expect(select(view.container, 'Narration voice').value).toBe('Kore');
    setValue(select(view.container, 'Narration engine'), 'fake');
    expect(select(view.container, 'Narration voice').value).toBe('alice');
    expect(view.container.textContent).toContain('1 scene will be narrated');
    expect(view.container.textContent).toContain('1 existing narration preserved');
    view.unmount();
  });

  it('applies a saved preset and explains generated and preserved scenes', async () => {
    const view = renderComponent(<MemoryRouter><ProjectNarrationPanel projectId="project" scenes={scenes} expressiveness="medium" expressivenessPending={false} onExpressivenessChange={() => {}} /></MemoryRouter>);
    await waitForUi(() => expect(select(view.container, 'Voice preset').options.length).toBe(2));
    setValue(select(view.container, 'Voice preset'), 'preset');
    expect(select(view.container, 'Narration voice').value).toBe('Puck');
    expect(view.container.textContent).toContain('1.2× speed');
    expect(view.container.textContent).toContain('Preserved');
    expect(view.container.textContent).toContain('Generate missing or changed paragraphs');
    view.unmount();
  });

  it('starts with exact options, reports completion, and never renders raw errors', async () => {
    const generate = vi.spyOn(narrationApi, 'generateProject').mockResolvedValue({ jobId: 'job-1', status: 'running' });
    let listener!: (event: { type: string; data?: unknown }) => void;
    vi.spyOn(jobsApi, 'stream').mockImplementation((_id, next) => { listener = next; return vi.fn(); });
    const view = renderComponent(
      <MemoryRouter><ProjectNarrationPanel
        projectId="project-1"
        scenes={scenes}
        expressiveness="heavy"
        expressivenessPending={false}
        onExpressivenessChange={vi.fn()}
      /></MemoryRouter>,
    );
    await waitForUi(() => expect(select(view.container, 'Narration engine').value).toBe('gemini'));
    act(() => [...view.container.querySelectorAll('button')].find((button) => button.textContent === 'Narrate project')!.click());
    await flushPromises();

    expect(generate).toHaveBeenCalledWith('project-1', {
      engine: 'gemini', voice: 'Kore', speed: 1, expressiveness: 'heavy', overwrite: false,
    });
    act(() => listener({
      type: 'progress',
      data: {
        sceneNumber: 1,
        totalScenes: 3,
        sceneName: 'One',
        generatedScenes: 0,
        preservedScenes: 0,
        noScriptScenes: 0,
        failedScenes: 0,
      },
    }));
    expect(view.container.textContent).toContain('Narrating 1 of 3');
    expect(view.container.textContent).toContain('0 generated');
    expect(view.container.textContent).toContain('0 failed');
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
      <MemoryRouter><ProjectNarrationPanel
        projectId="project-1"
        scenes={scenes}
        expressiveness="medium"
        expressivenessPending={false}
        onExpressivenessChange={vi.fn()}
      /></MemoryRouter>,
    );
    await waitForUi(() => expect(view.container.textContent).toContain('Cancel'));
    const cancelButton = [...view.container.querySelectorAll('button')].find((button) => button.textContent === 'Cancel')!;
    act(() => cancelButton.click());
    await flushPromises();

    expect(cancel).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111');
    expect(view.container.textContent).toContain('Cancellation requested');
    expect(generate).not.toHaveBeenCalled();
    view.unmount();
  });

  it('disables a no-op when every scripted paragraph already has audio', async () => {
    const fullyPreviewed = scenes.map((scene) => scene.narration?.script
      ? {
        ...scene,
        narration: {
          ...scene.narration,
          chunks: [{ index: 0, text: scene.narration.script, audio: `${scene.id}.mp3` }],
        },
      }
      : scene);
    const view = renderComponent(
      <MemoryRouter><ProjectNarrationPanel
        projectId="project-1"
        scenes={fullyPreviewed}
        expressiveness="medium"
        expressivenessPending={false}
        onExpressivenessChange={vi.fn()}
      /></MemoryRouter>,
    );
    await waitForUi(() => expect(select(view.container, 'Narration engine').value).toBe('gemini'));
    expect(view.container.textContent).toContain('0 scenes will be narrated');
    expect([...view.container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Narrate project')?.disabled).toBe(true);
    view.unmount();
  });

  it('renders failed scenes as deep links into each scene Narration tab', async () => {
    vi.spyOn(narrationApi, 'generateProject').mockResolvedValue({ jobId: 'job-1', status: 'running' });
    let listener!: (event: { type: string; data?: unknown }) => void;
    vi.spyOn(jobsApi, 'stream').mockImplementation((_id, next) => { listener = next; return vi.fn(); });
    const view = renderComponent(
      <MemoryRouter><ProjectNarrationPanel
        projectId="project-1"
        scenes={scenes}
        expressiveness="medium"
        expressivenessPending={false}
        onExpressivenessChange={vi.fn()}
      /></MemoryRouter>,
    );
    await waitForUi(() => expect(select(view.container, 'Narration engine').value).toBe('gemini'));
    act(() => [...view.container.querySelectorAll('button')].find((button) => button.textContent === 'Narrate project')!.click());
    await flushPromises();
    act(() => listener({
      type: 'done',
      data: {
        totalScenes: 3, generatedScenes: 0, generatedChunks: 0, preservedScenes: 0,
        noScriptScenes: 1, removedScenes: 0, failedScenes: 2, cancelled: false,
        failures: [
          { sceneId: 'one', sceneName: 'One', code: 'scene_generation_failed' },
          { sceneId: 'three', sceneName: 'Three', code: 'scene_generation_failed' },
        ],
      },
    }));

    const failures = view.container.querySelector('[aria-label="Scenes that could not be narrated"]')!;
    expect(failures.textContent).toContain("could not be narrated");
    expect(failures.textContent).toContain('Narration tab');
    const links = [...failures.querySelectorAll('a')];
    expect(links.map((a) => a.textContent)).toEqual(['One', 'Three']);
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '/project/project-1/scene/one?tab=Narration',
      '/project/project-1/scene/three?tab=Narration',
    ]);
    view.unmount();
  });

  it('offers an adjacent Retry after a failed run and starts again on click', async () => {
    const generate = vi.spyOn(narrationApi, 'generateProject')
      .mockRejectedValueOnce(new Error('tts down'))
      .mockResolvedValueOnce({ jobId: 'job-2', status: 'running' });
    let listener!: (event: { type: string; data?: unknown }) => void;
    vi.spyOn(jobsApi, 'stream').mockImplementation((_id, next) => { listener = next; return vi.fn(); });
    const view = renderComponent(
      <MemoryRouter><ProjectNarrationPanel
        projectId="project-1"
        scenes={scenes}
        expressiveness="medium"
        expressivenessPending={false}
        onExpressivenessChange={vi.fn()}
      /></MemoryRouter>,
    );
    await waitForUi(() => expect(select(view.container, 'Narration engine').value).toBe('gemini'));

    // Force a start failure.
    act(() => [...view.container.querySelectorAll('button')].find((button) => button.textContent === 'Narrate project')!.click());
    await flushPromises();

    const retry = [...view.container.querySelectorAll('button')].find((button) => button.textContent === 'Retry')!;
    act(() => retry.click());
    await flushPromises();

    expect(generate).toHaveBeenCalledTimes(2);
    // Once running again, the Retry button is replaced by Cancel.
    expect([...view.container.querySelectorAll('button')].some((button) => button.textContent === 'Cancel')).toBe(true);
    expect([...view.container.querySelectorAll('button')].some((button) => button.textContent === 'Retry')).toBe(false);
    view.unmount();
  });
});
