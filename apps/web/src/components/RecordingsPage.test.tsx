import { act } from 'react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Scene, Storyboard } from '@vpa/shared';
import { recordingsApi, storyboardApi } from '../lib/api.js';
import { chooseFile, flushPromises, renderComponent } from './component-test-utils.js';
import { RecordingsPage } from '../pages/RecordingsPage.js';

// RecordingsPage guards destructive bulk replace behind ui.confirm. Mock the
// UiProvider hook so the test controls the dialog's answer.
const confirmMock = vi.hoisted(() => vi.fn());
vi.mock('../components/ui/UiProvider.js', () => ({
  useUi: () => ({ confirm: confirmMock }),
}));

function scene(id: string, name: string, recorded: boolean): Scene {
  return {
    id,
    name,
    description: name,
    type: 'desktop',
    ...(recorded ? { recording: { source: `recordings/${id}.mp4`, duration_sec: 12 } } : {}),
  } as unknown as Scene;
}

const COMPLETE_STORYBOARD: Storyboard = {
  scenes: [scene('one', 'Intro', true), scene('two', 'Outro', true)],
} as unknown as Storyboard;

function renderPage() {
  return renderComponent(
    <MemoryRouter initialEntries={['/project/p1/recordings']}>
      <Routes>
        <Route
          path="/project/:projectId"
          element={<Outlet context={{ project: { id: 'p1', name: 'P1' } }} />}
        >
          <Route path="recordings" element={<RecordingsPage />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
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

async function openUploadFormAndChooseFile(view: ReturnType<typeof renderComponent>) {
  // Complete phase hides the upload form behind "upload all again".
  await waitForUi(() => {
    expect(
      [...view.container.querySelectorAll('button')].some(
        (button) => button.textContent === 'upload all again',
      ),
    ).toBe(true);
  });
  const toggle = [...view.container.querySelectorAll('button')]
    .find((button) => button.textContent === 'upload all again')!;
  act(() => toggle.click());
  await flushPromises();
  chooseFile(
    view.container.querySelector('input[type="file"]')!,
    new File(['mp4'], 'new.mp4', { type: 'video/mp4' }),
  );
  await flushPromises();
}

describe('RecordingsPage bulk replace confirmation', () => {
  beforeEach(() => {
    vi.spyOn(storyboardApi, 'get').mockResolvedValue(COMPLETE_STORYBOARD);
    vi.spyOn(recordingsApi, 'uploadBulk').mockResolvedValue({
      results: [],
      assignedCount: 2,
      totalScenes: 2,
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('asks for confirmation before overwriting every recording', async () => {
    confirmMock.mockResolvedValue(true);
    const view = renderPage();
    await flushPromises();
    await openUploadFormAndChooseFile(view);

    const replace = [...view.container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Replace recordings')!;
    act(() => replace.click());
    await flushPromises();

    expect(confirmMock).toHaveBeenCalledOnce();
    const arg = confirmMock.mock.calls[0]![0] as { destructive?: boolean; body?: string };
    expect(arg.destructive).toBe(true);
    expect(arg.body).toContain('overwrites');
    const uploadBulk = vi.mocked(recordingsApi.uploadBulk);
    expect(uploadBulk).toHaveBeenCalledOnce();
    expect(uploadBulk.mock.calls[0]![1]![0]!.name).toBe('new.mp4');
    view.unmount();
  });

  it('does not touch existing recordings when the user cancels the dialog', async () => {
    confirmMock.mockResolvedValue(false);
    const view = renderPage();
    await flushPromises();
    await openUploadFormAndChooseFile(view);

    const replace = [...view.container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Replace recordings')!;
    act(() => replace.click());
    await flushPromises();

    expect(confirmMock).toHaveBeenCalledOnce();
    expect(recordingsApi.uploadBulk).not.toHaveBeenCalled();
    view.unmount();
  });

  it('uploads fresh-phase files without a destructive prompt (no storyboard yet)', async () => {
    confirmMock.mockClear();
    vi.spyOn(storyboardApi, 'get').mockResolvedValue(null as unknown as Storyboard);
    const generate = vi.spyOn(recordingsApi, 'generateStoryboard').mockResolvedValue({
      scenes: [],
    } as unknown as Storyboard);
    const view = renderPage();
    await flushPromises();

    chooseFile(
      view.container.querySelector('input[type="file"]')!,
      new File(['mp4'], 'first.mp4', { type: 'video/mp4' }),
    );
    await flushPromises();

    const upload = [...view.container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('& build storyboard'))!;
    act(() => upload.click());
    await flushPromises();

    expect(generate).toHaveBeenCalledOnce();
    expect(confirmMock).not.toHaveBeenCalled();
    view.unmount();
  });
});
