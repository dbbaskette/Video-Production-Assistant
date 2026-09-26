import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderComponent } from '../components/component-test-utils.js';
import { setupApi, type SetupHealth as SetupHealthResult } from '../lib/api.js';
import { formatAge, SetupHealth } from './SetupHealth.js';

const checkedAt = new Date('2026-09-25T16:00:00.000Z').getTime();
const healthy: SetupHealthResult = {
  allOk: true,
  allClean: true,
  probes: [{ id: 'ffmpeg', label: 'FFmpeg', status: 'ok', message: 'Ready', ranAt: checkedAt }],
};

async function waitFor(assertion: () => void): Promise<void> {
  let failure: unknown;
  for (let index = 0; index < 30; index += 1) {
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });
    try { assertion(); return; } catch (error) { failure = error; }
  }
  throw failure;
}

describe('SetupHealth', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('preserves the last successful result when a refresh fails', async () => {
    vi.spyOn(setupApi, 'health')
      .mockResolvedValueOnce(healthy)
      .mockRejectedValueOnce(new Error('probe unavailable'));
    const view = renderComponent(<SetupHealth />);
    await waitFor(() => expect(view.container.textContent).toContain('Everything\'s ready'));

    act(() => [...view.container.querySelectorAll('button')].find((button) => button.textContent?.includes('Re-check'))!.click());
    await waitFor(() => expect(view.container.textContent).toContain('Refresh failed'));

    expect(view.container.textContent).toContain('Healthy checks (1)');
    expect(view.container.textContent).toContain('Showing the last successful result');
    expect(view.container.querySelector('time')?.dateTime).toBe(new Date(checkedAt).toISOString());
    view.unmount();
  });

  it('formats probe age without reporting future or negative time', () => {
    expect(formatAge(checkedAt, checkedAt + 45_000)).toBe('45s ago');
    expect(formatAge(checkedAt, checkedAt + 120_000)).toBe('2m ago');
    expect(formatAge(checkedAt + 10_000, checkedAt)).toBe('0s ago');
  });
});
