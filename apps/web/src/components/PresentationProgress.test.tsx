import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { presentationsApi } from '../lib/api.js';
import { flushPromises, renderComponent } from './component-test-utils.js';
import { PresentationProgress } from './PresentationProgress.js';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const PROCESSING = {
  schema_version: 1 as const,
  id: '22222222-2222-4222-8222-222222222222', project_id: PROJECT_ID,
  filename: 'deck.pdf', status: 'processing' as const, stage: 'processing-slides' as const,
  generate_narration: true, page_count: 4, processed_pages: 1, analyzed_pages: 0,
  scripted_pages: 0, remaining_scene_count: 0, deterministic_commit: 'uncommitted' as const,
  created_at: '2026-08-05T12:00:00.000Z', updated_at: '2026-08-05T12:00:00.000Z',
};
const READY = {
  ...PROCESSING,
  status: 'ready' as const,
  stage: 'ready' as const,
  processed_pages: 4,
  deterministic_commit: 'committed' as const,
  updated_at: '2026-08-05T12:00:01.000Z',
};

describe('PresentationProgress', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('polls only while nonterminal and invalidates both consumers once on ready', async () => {
    const get = vi.spyOn(presentationsApi, 'get').mockResolvedValue(READY);
    const view = renderComponent(<PresentationProgress projectId={PROJECT_ID} initialJob={PROCESSING} onClose={vi.fn()} />);
    const invalidate = vi.spyOn(view.client, 'invalidateQueries').mockResolvedValue(undefined);
    expect(view.container.querySelector('[aria-live="polite"]')?.textContent).toContain('1 of 4 slides processed');

    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    await flushPromises();
    expect(get).toHaveBeenCalledOnce();
    expect(view.container.textContent).toContain('Presentation ready');
    expect(invalidate.mock.calls.map(([arg]) => arg)).toEqual([
      { queryKey: ['storyboard', PROJECT_ID] },
      { queryKey: ['presentations', PROJECT_ID] },
    ]);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(get).toHaveBeenCalledOnce();
    expect(invalidate).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it('stops polling on unmount and never exposes raw polling errors', async () => {
    const get = vi.spyOn(presentationsApi, 'get').mockRejectedValue(new Error('GET /private/job record'));
    const view = renderComponent(<PresentationProgress projectId={PROJECT_ID} initialJob={PROCESSING} onClose={vi.fn()} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    await flushPromises();
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('Check this presentation again');
    expect(view.container.textContent).not.toContain('/private/job');
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(get).toHaveBeenCalledOnce();
  });

  it('does not poll or invalidate for an initially terminal job and close only closes the surface', async () => {
    const get = vi.spyOn(presentationsApi, 'get');
    const onClose = vi.fn();
    const view = renderComponent(<PresentationProgress projectId={PROJECT_ID} initialJob={READY} onClose={onClose} />);
    const invalidate = vi.spyOn(view.client, 'invalidateQueries');
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(get).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
    act(() => view.container.querySelector<HTMLButtonElement>('button[aria-label="Close presentation progress"]')!.click());
    expect(onClose).toHaveBeenCalledOnce();
    view.unmount();
  });

  it('invalidates once when the same job transitions to ready through a new owner snapshot', async () => {
    const get = vi.spyOn(presentationsApi, 'get');
    const onTerminal = vi.fn();
    const view = renderComponent(
      <PresentationProgress projectId={PROJECT_ID} initialJob={PROCESSING} onClose={vi.fn()} onTerminal={onTerminal} />,
    );
    const invalidate = vi.spyOn(view.client, 'invalidateQueries').mockResolvedValue(undefined);

    view.rerender(
      <PresentationProgress projectId={PROJECT_ID} initialJob={READY} onClose={vi.fn()} onTerminal={onTerminal} />,
    );
    await flushPromises();

    expect(get).not.toHaveBeenCalled();
    expect(invalidate.mock.calls.map(([arg]) => arg)).toEqual([
      { queryKey: ['storyboard', PROJECT_ID] },
      { queryKey: ['presentations', PROJECT_ID] },
    ]);
    expect(onTerminal).toHaveBeenCalledOnce();
    expect(onTerminal).toHaveBeenCalledWith(READY);
    view.unmount();
  });

  it('stops polling immediately when close is requested even before parent unmount', async () => {
    const get = vi.spyOn(presentationsApi, 'get');
    const view = renderComponent(<PresentationProgress projectId={PROJECT_ID} initialJob={PROCESSING} onClose={vi.fn()} />);
    act(() => view.container.querySelector<HTMLButtonElement>('button[aria-label="Close presentation progress"]')!.click());
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(get).not.toHaveBeenCalled();
    view.unmount();
  });
});
