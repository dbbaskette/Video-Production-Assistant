import { act } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderComponent } from '../components/component-test-utils.js';
import { settingsApi, tanzuBrandSetupApi, ttsApi, voiceApi } from '../lib/api.js';
import { Settings } from './Settings.js';

const missingAssignments = {
  assignments: {},
  resolved: [
    { role: 'video-understanding' as const, scope: 'global' as const, ready: false as const, code: 'model_assignment_missing' as const, message: 'Missing' },
    { role: 'writing' as const, scope: 'global' as const, ready: false as const, code: 'model_assignment_missing' as const, message: 'Missing' },
    { role: 'general' as const, scope: 'global' as const, ready: false as const, code: 'model_assignment_missing' as const, message: 'Missing' },
  ],
};

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

describe('Settings Tanzu Brand setup', () => {
  beforeEach(() => {
    vi.spyOn(settingsApi, 'listModels').mockResolvedValue([]);
    vi.spyOn(settingsApi, 'getModelRouting').mockResolvedValue(missingAssignments);
    vi.spyOn(voiceApi, 'list').mockResolvedValue([]);
    vi.spyOn(ttsApi, 'listEngines').mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('shows detected missing state and requires confirmation before starting installation', async () => {
    vi.spyOn(tanzuBrandSetupApi, 'status').mockResolvedValue({
      state: 'not-installed',
      installed: false,
      message: 'Tanzu Brand is not installed.',
      updatedAt: '2026-09-26T12:00:00.000Z',
    });
    const install = vi.spyOn(tanzuBrandSetupApi, 'install').mockResolvedValue({
      installationId: '09e395ec-8b40-4b55-9622-d329398413a0',
      state: 'installing',
    });
    const view = renderComponent(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><Settings /></MemoryRouter>,
    );
    await waitForUi(() => expect(view.container.textContent).toContain('Not installed'));

    const start = [...view.container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Download and install')!;
    act(() => start.click());
    expect(install).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('authenticated GitHub CLI');

    const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
      .find((button) => button.textContent === 'Download and install')!;
    act(() => confirm.click());
    await waitForUi(() => expect(install).toHaveBeenCalledOnce());
    view.unmount();
  });
});
