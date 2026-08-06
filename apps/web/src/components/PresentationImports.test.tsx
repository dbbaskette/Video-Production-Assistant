import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryObserver, type QueryClient, type QueryKey } from '@tanstack/react-query';
import type { PresentationJob, Scene } from '@vpa/shared';
import { presentationsApi, storyboardApi } from '../lib/api.js';
import { renderComponent } from './component-test-utils.js';
import { PresentationImports } from './PresentationImports.js';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const PRESENTATION_A = '22222222-2222-4222-8222-222222222222';
const PRESENTATION_B = '33333333-3333-4333-8333-333333333333';

function job(overrides: Partial<PresentationJob> = {}): PresentationJob {
  return {
    schema_version: 1,
    id: PRESENTATION_A,
    project_id: PROJECT_ID,
    filename: 'launch-deck.pdf',
    status: 'ready',
    stage: 'ready',
    generate_narration: false,
    page_count: 3,
    processed_pages: 3,
    analyzed_pages: 0,
    scripted_pages: 0,
    remaining_scene_count: 3,
    deterministic_commit: 'committed',
    created_at: '2026-08-05T12:00:00.000Z',
    updated_at: '2026-08-05T12:00:00.000Z',
    ...overrides,
  };
}

function scene(id: string, presentationId?: string): Scene {
  return {
    id,
    name: id,
    description: '',
    type: presentationId ? 'slide' : 'browser',
    ...(presentationId
      ? {
          presentation_source: {
            presentation_id: presentationId,
            page_number: 1,
            page_count: 3,
            image: `presentations/${presentationId}/pages/page-0001.png`,
            hold_duration_sec: 5,
          },
        }
      : {}),
  };
}

async function renderLoaded(
  jobs: PresentationJob[],
  props: Partial<React.ComponentProps<typeof PresentationImports>> = {},
) {
  vi.spyOn(presentationsApi, 'list').mockResolvedValue(jobs);
  const view = renderComponent(
    <PresentationImports projectId={PROJECT_ID} scenes={[]} {...props} />,
  );
  await waitForUi(() => expect(view.container.textContent).toContain('Presentations'));
  await waitForUi(() => expect(presentationsApi.list).toHaveBeenCalled());
  if (jobs.length > 0) {
    await waitForUi(() => expect(
      view.container.querySelector(`[data-testid="presentation-import-${jobs[0]!.id}"]`),
    ).not.toBeNull());
  } else {
    await waitForUi(() => expect(view.container.textContent).toContain('No presentation imports yet'));
  }
  return view;
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

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll('button')]
    .find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function observeCache(client: QueryClient, queryKey: QueryKey) {
  client.setQueryData(queryKey, { value: 'before retry' });
  const queryFn = vi.fn().mockResolvedValue({ value: 'after retry' });
  const observer = new QueryObserver(client, { queryKey, queryFn, staleTime: Infinity });
  const unsubscribe = observer.subscribe(() => undefined);
  return { queryFn, unsubscribe };
}

describe('PresentationImports', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('renders loading, empty, and bounded list-error states', async () => {
    let resolveList!: (value: PresentationJob[]) => void;
    vi.spyOn(presentationsApi, 'list').mockImplementationOnce(
      () => new Promise((resolve) => { resolveList = resolve; }),
    );
    const loading = renderComponent(<PresentationImports projectId={PROJECT_ID} scenes={[]} />);
    expect(loading.container.textContent).toContain('Loading presentations');
    await act(async () => resolveList([]));
    await waitForUi(() => expect(loading.container.textContent).toContain('No presentation imports yet'));
    loading.unmount();

    vi.mocked(presentationsApi.list).mockRejectedValueOnce(
      new Error('untrusted diagnostic marker one'),
    );
    const failed = renderComponent(<PresentationImports projectId={PROJECT_ID} scenes={[]} />);
    await waitForUi(() => expect(failed.container.querySelector('[role="alert"]')).not.toBeNull());
    expect(failed.container.textContent).toContain('Presentations could not be loaded');
    expect(failed.container.textContent).not.toContain('untrusted diagnostic marker one');
    failed.unmount();
  });

  it('uses the Task 8 action matrix and bounded metadata without exposing raw job errors', async () => {
    const recoverable = job({
      id: PRESENTATION_A,
      filename: `${'Quarterly '.repeat(30)}.pdf`,
      status: 'failed',
      stage: 'failed',
      page_count: 12,
      processed_pages: 0,
      remaining_scene_count: 0,
      deterministic_commit: 'uncommitted',
      error: { code: 'processing_failed', message: 'untrusted diagnostic marker two' },
    });
    const narration = job({
      id: PRESENTATION_B,
      filename: 'narration.pdf',
      status: 'partial',
      stage: 'drafting-narration',
      generate_narration: true,
      deterministic_commit: 'committed',
      remaining_scene_count: 1,
      error: { code: 'narration_failed', message: 'untrusted diagnostic marker three' },
    });
    const view = await renderLoaded([recoverable, narration]);
    const first = view.container.querySelector(`[data-testid="presentation-import-${PRESENTATION_A}"]`)!;
    const second = view.container.querySelector(`[data-testid="presentation-import-${PRESENTATION_B}"]`)!;

    expect(first.textContent).toContain('Retry import');
    expect(first.textContent).not.toContain('Retry narration');
    expect(first.textContent).toContain('Remove imported deck');
    expect(first.textContent).toContain('12 pages');
    expect(first.textContent).toContain('0 scenes remain');
    expect(first.querySelector('.presentation-imports__name')?.textContent?.length).toBeLessThanOrEqual(121);
    expect(second.textContent).not.toContain('Retry import');
    expect(second.textContent).toContain('Retry narration');
    expect(second.textContent).toContain('Remove imported deck');
    expect(second.textContent).toContain('1 scene remains');
    expect(view.container.textContent).not.toContain('untrusted diagnostic marker two');
    expect(view.container.textContent).not.toContain('untrusted diagnostic marker three');
    expect(view.container.querySelector('time')?.getAttribute('datetime')).toBe(recoverable.created_at);
    view.unmount();
  });

  it.each([
    ['uploading', job({ status: 'processing', stage: 'uploading', deterministic_commit: 'uncommitted' }), []],
    ['processing slides', job({ status: 'processing', stage: 'processing-slides', deterministic_commit: 'uncommitted' }), []],
    ['creating scenes', job({ status: 'processing', stage: 'creating-scenes', deterministic_commit: 'uncommitted' }), []],
    ['drafting narration', job({
      status: 'processing',
      stage: 'drafting-narration',
      generate_narration: true,
      deterministic_commit: 'committed',
    }), ['Remove imported deck']],
    ['ready', job(), ['Remove imported deck']],
    ['partial narration', job({
      status: 'partial',
      stage: 'drafting-narration',
      generate_narration: true,
      error: { code: 'narration_failed', message: 'untrusted diagnostic marker four' },
    }), ['Retry narration', 'Remove imported deck']],
    ['recoverable import failure', job({
      status: 'failed',
      stage: 'failed',
      deterministic_commit: 'uncommitted',
      error: { code: 'processing_failed', message: 'untrusted diagnostic marker five' },
    }), ['Retry import', 'Remove imported deck']],
    ['unavailable source', job({
      status: 'failed',
      stage: 'failed',
      deterministic_commit: 'uncommitted',
      error: { code: 'source_not_available', message: 'untrusted diagnostic marker six' },
    }), ['Remove imported deck']],
    ['commit-pending recovery', job({
      status: 'failed',
      stage: 'failed',
      deterministic_commit: 'commit-pending',
      error: { code: 'storyboard_commit_failed', message: 'untrusted diagnostic marker seven' },
    }), ['Retry import', 'Remove imported deck']],
    ['committed narration failure', job({
      status: 'failed',
      stage: 'failed',
      generate_narration: true,
      deterministic_commit: 'committed',
      error: { code: 'narration_failed', message: 'untrusted diagnostic marker eight' },
    }), ['Retry narration', 'Remove imported deck']],
    ['deletion tombstone', job({ deletion_pending: true }), []],
  ] as const)('wires the complete action matrix for %s', async (_label, input, expected) => {
    const view = await renderLoaded([input]);
    const item = view.container.querySelector(
      `[data-testid="presentation-import-${PRESENTATION_A}"]`,
    )!;
    const actions = [...item.querySelectorAll('button')]
      .map((candidate) => candidate.textContent?.trim())
      .filter((candidate): candidate is string => Boolean(candidate));

    expect(actions).toEqual(expected);
    view.unmount();
  });

  it('updates only the affected job from retry responses and prevents double submission', async () => {
    let resolveRetry!: (value: PresentationJob) => void;
    const failed = job({
      status: 'failed',
      stage: 'failed',
      deterministic_commit: 'uncommitted',
      error: { code: 'processing_failed', message: 'untrusted diagnostic marker nine' },
    });
    const other = job({ id: PRESENTATION_B, filename: 'other.pdf' });
    const retry = vi.spyOn(presentationsApi, 'retryImport').mockImplementation(
      () => new Promise((resolve) => { resolveRetry = resolve; }),
    );
    const view = await renderLoaded([failed, other]);
    const retryButton = button(view.container, 'Retry import');
    const otherRemove = view.container
      .querySelector(`[data-testid="presentation-import-${PRESENTATION_B}"] button`)! as HTMLButtonElement;

    act(() => { retryButton.click(); retryButton.click(); });
    expect(retry).toHaveBeenCalledOnce();
    expect(retryButton.disabled).toBe(true);
    expect(otherRemove.disabled).toBe(false);

    await act(async () => resolveRetry(job({
      status: 'processing',
      stage: 'processing-slides',
      processed_pages: 1,
      deterministic_commit: 'uncommitted',
      error: undefined,
    })));
    await waitForUi(() => expect(view.container.textContent).toContain('1 of 3 slides processed'));
    expect(view.container.textContent).not.toContain('Retry import');
    view.unmount();
  });

  it('maps retry failures to actionable copy and never leaks the rejected body', async () => {
    vi.spyOn(presentationsApi, 'retryNarration').mockRejectedValue(
      new Error('untrusted diagnostic marker ten'),
    );
    const view = await renderLoaded([job({
      status: 'partial',
      stage: 'drafting-narration',
      generate_narration: true,
      error: { code: 'narration_failed', message: 'untrusted diagnostic marker eleven' },
    })]);
    act(() => button(view.container, 'Retry narration').click());
    await waitForUi(() => expect(view.container.querySelector('[role="alert"]')).not.toBeNull());
    expect(view.container.textContent).toContain('Narration could not be retried');
    expect(view.container.textContent).not.toContain('untrusted diagnostic marker ten');
    expect(view.container.textContent).not.toContain('untrusted diagnostic marker eleven');
    view.unmount();
  });

  it.each([
    ['ready', job({
      status: 'ready',
      stage: 'ready',
      generate_narration: true,
      error: undefined,
      updated_at: '2026-08-05T12:00:02.000Z',
    })],
    ['partial', job({
      status: 'partial',
      stage: 'drafting-narration',
      generate_narration: true,
      error: { code: 'narration_failed', message: 'bounded failure' },
      updated_at: '2026-08-05T12:00:02.000Z',
    })],
  ] as const)('refreshes Storyboard and owned open-scene caches after a terminal %s narration retry', async (_label, next) => {
    const starting = job({
      status: 'partial',
      stage: 'drafting-narration',
      generate_narration: true,
      error: { code: 'narration_failed', message: 'bounded failure' },
    });
    vi.spyOn(presentationsApi, 'list')
      .mockResolvedValueOnce([starting])
      .mockResolvedValue([next]);
    vi.spyOn(presentationsApi, 'retryNarration').mockResolvedValue(next);
    const ownedScene = scene('owned-scene', PRESENTATION_A);
    const unrelatedScene = scene('unrelated-scene', PRESENTATION_B);
    const view = renderComponent(
      <PresentationImports
        projectId={PROJECT_ID}
        scenes={[ownedScene, unrelatedScene]}
      />,
    );
    await waitForUi(() => expect(view.container.textContent).toContain('Retry narration'));

    const storyboard = observeCache(view.client, ['storyboard', PROJECT_ID]);
    const ownedScript = observeCache(view.client, ['script', PROJECT_ID, ownedScene.id]);
    const ownedNarration = observeCache(view.client, ['narration', PROJECT_ID, ownedScene.id]);
    const unrelatedScript = observeCache(view.client, ['script', PROJECT_ID, unrelatedScene.id]);
    const unrelatedNarration = observeCache(view.client, ['narration', PROJECT_ID, unrelatedScene.id]);

    act(() => button(view.container, 'Retry narration').click());
    await waitForUi(() => expect(storyboard.queryFn).toHaveBeenCalledOnce());
    await waitForUi(() => expect(ownedScript.queryFn).toHaveBeenCalledOnce());
    expect(ownedNarration.queryFn).toHaveBeenCalledOnce();
    expect(unrelatedScript.queryFn).not.toHaveBeenCalled();
    expect(unrelatedNarration.queryFn).not.toHaveBeenCalled();
    expect(presentationsApi.list).toHaveBeenCalledTimes(2);

    storyboard.unsubscribe();
    ownedScript.unsubscribe();
    ownedNarration.unsubscribe();
    unrelatedScript.unsubscribe();
    unrelatedNarration.unsubscribe();
    view.unmount();
  });

  it.each([
    [0, 'No remaining scenes will be deleted. Presentation assets will be removed.'],
    [1, '1 remaining scene will be deleted.'],
    [3, '3 remaining scenes will be deleted.'],
  ])('refreshes removal details and uses exact confirmation copy for %i scenes', async (count, copy) => {
    const current = job({ remaining_scene_count: count });
    const get = vi.spyOn(presentationsApi, 'get').mockResolvedValue(current);
    const view = await renderLoaded([job({ remaining_scene_count: 9 })]);

    act(() => button(view.container, 'Remove imported deck').click());
    await waitForUi(() => expect(view.container.querySelector('[role="dialog"]')).not.toBeNull());
    expect(get).toHaveBeenCalledWith(PROJECT_ID, PRESENTATION_A);
    expect(view.container.querySelector('[role="dialog"]')?.textContent).toContain(copy);
    expect(view.container.querySelector('[role="dialog"]')?.textContent).not.toContain('9 remaining');
    view.unmount();
  });

  it('removes once, invalidates both server-owned views, and reports the refetched scene context', async () => {
    const before = [scene('slide-a', PRESENTATION_A), scene('unrelated'), scene('slide-b', PRESENTATION_A)];
    const after = [before[1]!];
    vi.spyOn(presentationsApi, 'get').mockResolvedValue(job({ remaining_scene_count: 2 }));
    const remove = vi.spyOn(presentationsApi, 'remove').mockResolvedValue();
    vi.spyOn(storyboardApi, 'get').mockResolvedValue({
      schema_version: 1,
      project: { id: PROJECT_ID, name: 'demo', created: '2026-08-05T12:00:00.000Z' },
      scenes: after,
    });
    const onRemoved = vi.fn();
    const view = await renderLoaded([job({ remaining_scene_count: 2 })], { scenes: before, onRemoved });
    vi.mocked(presentationsApi.list).mockResolvedValueOnce([]);

    act(() => button(view.container, 'Remove imported deck').click());
    await waitForUi(() => expect(view.container.querySelector('[role="dialog"]')).not.toBeNull());
    const confirm = [...view.container.querySelectorAll('[role="dialog"] button')]
      .find((candidate) => candidate.textContent === 'Remove imported deck')! as HTMLButtonElement;
    act(() => { confirm.click(); confirm.click(); });
    await waitForUi(() => expect(remove).toHaveBeenCalledOnce());
    await waitForUi(() => expect(onRemoved).toHaveBeenCalledOnce());

    expect(onRemoved).toHaveBeenCalledWith({
      presentationId: PRESENTATION_A,
      previousScenes: before,
      removedSceneIds: ['slide-a', 'slide-b'],
      freshScenes: after,
      refreshFailed: false,
    });
    view.unmount();
  });

  it('uses strict fresh data after DELETE and restores focus to the stable disclosure', async () => {
    const before = [scene('slide-a', PRESENTATION_A), scene('unrelated')];
    const freshStoryboard = {
      schema_version: 1 as const,
      project: { id: PROJECT_ID, name: 'demo', created: '2026-08-05T12:00:00.000Z' },
      scenes: [before[1]!],
    };
    vi.spyOn(presentationsApi, 'get').mockResolvedValue(job({ remaining_scene_count: 1 }));
    vi.spyOn(presentationsApi, 'remove').mockResolvedValue();
    vi.spyOn(storyboardApi, 'get').mockResolvedValue(freshStoryboard);
    const onRemoved = vi.fn();
    const view = await renderLoaded([job({ remaining_scene_count: 1 })], { scenes: before, onRemoved });
    vi.mocked(presentationsApi.list).mockResolvedValueOnce([]);
    const disclosure = view.container.querySelector<HTMLButtonElement>(
      '.presentation-imports__disclosure',
    )!;
    const opener = button(view.container, 'Remove imported deck');
    opener.focus();

    act(() => opener.click());
    await waitForUi(() => expect(view.container.querySelector('[role="dialog"]')).not.toBeNull());
    act(() => button(view.container.querySelector('[role="dialog"]')!, 'Remove imported deck').click());

    await waitForUi(() => expect(view.container.querySelector('[role="dialog"]')).toBeNull());
    await waitForUi(() => expect(
      view.container.querySelector(`[data-testid="presentation-import-${PRESENTATION_A}"]`),
    ).toBeNull());
    expect(storyboardApi.get).toHaveBeenCalledWith(PROJECT_ID);
    expect(onRemoved).toHaveBeenCalledWith({
      presentationId: PRESENTATION_A,
      previousScenes: before,
      removedSceneIds: ['slide-a'],
      freshScenes: [before[1]],
      refreshFailed: false,
    });
    expect(document.activeElement).toBe(disclosure);
    view.unmount();
  });

  it.each([
    ['Storyboard', true, false],
    ['presentation list', false, true],
  ] as const)('keeps DELETE authoritative when the %s refresh fails', async (_label, storyboardFails, listFails) => {
    const before = [scene('slide-a', PRESENTATION_A), scene('unrelated')];
    const freshStoryboard = {
      schema_version: 1 as const,
      project: { id: PROJECT_ID, name: 'demo', created: '2026-08-05T12:00:00.000Z' },
      scenes: [before[1]!],
    };
    vi.spyOn(presentationsApi, 'get').mockResolvedValue(job({ remaining_scene_count: 1 }));
    vi.spyOn(presentationsApi, 'remove').mockResolvedValue();
    const storyboardGet = vi.spyOn(storyboardApi, 'get');
    if (storyboardFails) storyboardGet.mockRejectedValue(new Error('untrusted storyboard diagnostic'));
    else storyboardGet.mockResolvedValue(freshStoryboard);
    const onRemoved = vi.fn();
    const view = await renderLoaded([job({ remaining_scene_count: 1 })], { scenes: before, onRemoved });
    view.client.setQueryData(['storyboard', PROJECT_ID], freshStoryboard);
    if (listFails) {
      vi.mocked(presentationsApi.list).mockRejectedValueOnce(new Error('untrusted list diagnostic'));
    } else {
      vi.mocked(presentationsApi.list).mockResolvedValueOnce([]);
    }

    act(() => button(view.container, 'Remove imported deck').click());
    await waitForUi(() => expect(view.container.querySelector('[role="dialog"]')).not.toBeNull());
    act(() => button(view.container.querySelector('[role="dialog"]')!, 'Remove imported deck').click());

    await waitForUi(() => expect(view.container.textContent).toContain(
      'Presentation was removed, but current project details could not be refreshed',
    ));
    expect(view.container.textContent).not.toContain('Removal could not be confirmed');
    expect(view.container.textContent).not.toContain('untrusted');
    expect(view.container.querySelector(`[data-testid="presentation-import-${PRESENTATION_A}"]`)).toBeNull();
    expect(view.client.getQueryState(['presentations', PROJECT_ID])?.isInvalidated).toBe(true);
    expect(view.client.getQueryState(['storyboard', PROJECT_ID])?.isInvalidated).toBe(true);
    expect(onRemoved).toHaveBeenCalledWith({
      presentationId: PRESENTATION_A,
      previousScenes: before,
      removedSceneIds: ['slide-a'],
      freshScenes: storyboardFails ? null : [before[1]],
      refreshFailed: true,
    });
    view.unmount();
  });

  it('refetches after remove failure without optimistic ghost state and shows bounded cleanup guidance', async () => {
    vi.spyOn(presentationsApi, 'get').mockResolvedValue(job({ remaining_scene_count: 1 }));
    vi.spyOn(presentationsApi, 'remove').mockRejectedValue(
      new Error('untrusted diagnostic marker twelve'),
    );
    const view = await renderLoaded([job({ remaining_scene_count: 1 })]);
    const invalidate = vi.spyOn(view.client, 'invalidateQueries');
    act(() => button(view.container, 'Remove imported deck').click());
    await waitForUi(() => expect(view.container.querySelector('[role="dialog"]')).not.toBeNull());
    act(() => button(view.container.querySelector('[role="dialog"]')!, 'Remove imported deck').click());
    await waitForUi(() => expect(view.container.querySelector('[role="alert"]')).not.toBeNull());

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['presentations', PROJECT_ID] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['storyboard', PROJECT_ID] });
    expect(view.container.textContent).toContain('Removal could not be confirmed');
    expect(view.container.textContent).not.toContain('untrusted diagnostic marker twelve');
    expect(view.container.querySelector(`[data-testid="presentation-import-${PRESENTATION_A}"]`)).not.toBeNull();
    view.unmount();
  });

  it('traps focus, closes on Escape, and restores the removal opener', async () => {
    vi.spyOn(presentationsApi, 'get').mockResolvedValue(job());
    const view = await renderLoaded([job()]);
    const opener = button(view.container, 'Remove imported deck');
    opener.focus();
    act(() => opener.click());
    await waitForUi(() => expect(view.container.querySelector('[role="dialog"]')).not.toBeNull());
    await waitForUi(() => expect(document.activeElement?.textContent).toBe('Cancel'));
    const confirm = button(view.container.querySelector('[role="dialog"]')!, 'Remove imported deck');
    confirm.focus();
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })));
    expect(document.activeElement?.textContent).toBe('Cancel');
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await waitForUi(() => expect(view.container.querySelector('[role="dialog"]')).toBeNull());
    expect(document.activeElement).toBe(opener);
    view.unmount();
  });

  it('polls while a listed job is nonterminal, stops at terminal, and stops on unmount', async () => {
    vi.useFakeTimers();
    try {
      const list = vi.spyOn(presentationsApi, 'list')
        .mockResolvedValueOnce([job({ status: 'processing', stage: 'processing-slides' })])
        .mockResolvedValueOnce([job()]);
      const view = renderComponent(<PresentationImports projectId={PROJECT_ID} scenes={[]} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(list).toHaveBeenCalledOnce();
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      expect(list).toHaveBeenCalledTimes(2);
      await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
      expect(list).toHaveBeenCalledTimes(2);
      view.unmount();
      await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
      expect(list).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
