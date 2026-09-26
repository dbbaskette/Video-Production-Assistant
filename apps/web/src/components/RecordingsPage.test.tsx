import { act } from 'react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Scene, Storyboard } from '@vpa/shared';
import { assetsApi, recordingsApi, storyboardApi } from '../lib/api.js';
import { chooseFile, flushPromises, renderComponent } from './component-test-utils.js';
import { RecordingsPage } from '../pages/RecordingsPage.js';

// RecordingsPage guards destructive bulk replace behind ui.confirm. Mock the
// UiProvider hook so the test controls the dialog's answer.
const confirmMock = vi.hoisted(() => vi.fn());
vi.mock('../components/ui/UiProvider.js', () => ({
  UiProvider: ({ children }: { children: React.ReactNode }) => children,
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

const IMPORTED_ASSET = {
  id: `asset_${'a'.repeat(64)}`,
  checksum: 'a'.repeat(64),
  original_name: 'new.mp4',
  source: `.vpa/assets/originals/${'a'.repeat(64)}.mp4`,
  origin: 'source' as const,
  media_kind: 'video' as const,
  mime_type: 'video/mp4',
  size_bytes: 3,
  imported_at: '2026-09-25T12:00:00.000Z',
  timing_origin_ms: 0,
  preparation: { status: 'ready' as const, attempts: 1, updated_at: '2026-09-25T12:00:00.000Z' },
};

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

async function openSourceTrayAndChooseFile(view: ReturnType<typeof renderComponent>) {
  await waitForUi(() => {
    expect(
      [...view.container.querySelectorAll('button')].some(
        (button) => button.textContent?.includes('Source tray'),
      ),
    ).toBe(true);
  });
  const toggle = [...view.container.querySelectorAll('button')]
    .find((button) => button.textContent?.includes('Source tray'))!;
  act(() => toggle.click());
  await flushPromises();
  chooseFile(
    view.container.querySelector('input[type="file"]')!,
    new File(['mp4'], 'new.mp4', { type: 'video/mp4' }),
  );
  await flushPromises();
}

describe('RecordingsPage source mapping', () => {
  beforeEach(() => {
    vi.spyOn(storyboardApi, 'get').mockResolvedValue(COMPLETE_STORYBOARD);
    vi.spyOn(assetsApi, 'list').mockResolvedValue([IMPORTED_ASSET]);
    vi.spyOn(assetsApi, 'currentRevision').mockResolvedValue(0);
    vi.spyOn(assetsApi, 'import').mockResolvedValue([IMPORTED_ASSET]);
    vi.spyOn(assetsApi, 'assign').mockResolvedValue({ revision: 1 });
    vi.spyOn(assetsApi, 'retry').mockResolvedValue(IMPORTED_ASSET);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('imports first and requires an explicit reviewed mapping action', async () => {
    const view = renderPage();
    await flushPromises();
    await openSourceTrayAndChooseFile(view);

    const importButton = [...view.container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Import 1 source')!;
    act(() => importButton.click());
    await flushPromises();
    expect(assetsApi.import).toHaveBeenCalledOnce();
    expect(assetsApi.assign).not.toHaveBeenCalled();
    const assign = [...view.container.querySelectorAll('button')]
      .find((button) => button.textContent?.startsWith('Assign 1 source'))!;
    act(() => assign.click());
    await flushPromises();
    expect(assetsApi.assign).toHaveBeenCalledWith(
      'p1',
      0,
      [{ assetId: `asset_${'a'.repeat(64)}`, sceneId: 'one', role: 'screen', timingOriginMs: 0 }],
    );
    view.unmount();
  });

  it('does not replace recordings merely by importing sources', async () => {
    const view = renderPage();
    await flushPromises();
    await openSourceTrayAndChooseFile(view);

    const importButton = [...view.container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Import 1 source')!;
    act(() => importButton.click());
    await flushPromises();
    expect(assetsApi.assign).not.toHaveBeenCalled();
    view.unmount();
  });

  it('offers a retry when preview preparation failed', async () => {
    vi.spyOn(assetsApi, 'list').mockResolvedValue([{
      ...IMPORTED_ASSET,
      preparation: {
        status: 'failed',
        attempts: 1,
        updated_at: '2026-09-25T12:00:00.000Z',
        error: { code: 'preview_failed', message: 'Could not prepare preview.' },
      },
    }]);
    const view = renderPage();
    await flushPromises();
    const toggle = [...view.container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Source tray'))!;
    act(() => toggle.click());
    await waitForUi(() => {
      expect([...view.container.querySelectorAll('button')]
        .some((button) => button.textContent === 'Retry preview preparation')).toBe(true);
    });
    const retry = [...view.container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Retry preview preparation')!;
    act(() => retry.click());
    await flushPromises();
    expect(assetsApi.retry).toHaveBeenCalledWith('p1', IMPORTED_ASSET.id);
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
