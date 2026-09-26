import { act } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, brandsApi, voiceCloneApi } from '../../lib/api.js';
import { flushPromises, renderComponent } from '../component-test-utils.js';
import { CommandPalette } from './CommandPalette.js';

function Location() {
  return <output aria-label="Location">{useLocation().pathname}</output>;
}

describe('CommandPalette', () => {
  beforeEach(() => {
    vi.spyOn(api, 'listProjects').mockResolvedValue({ projects: [] });
    vi.spyOn(brandsApi, 'list').mockResolvedValue({ brands: [], default_brand_id: null });
    vi.spyOn(voiceCloneApi, 'list').mockResolvedValue([]);
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('exposes a navigable combobox/listbox relationship and active selection', async () => {
    const view = renderComponent(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Routes><Route path="*" element={<><CommandPalette /><Location /></>} /></Routes>
      </MemoryRouter>,
    );

    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true })));
    await flushPromises();

    const input = view.container.querySelector<HTMLInputElement>('[role="combobox"]')!;
    const listbox = view.container.querySelector<HTMLElement>('[role="listbox"]')!;
    const options = [...listbox.querySelectorAll<HTMLElement>('[role="option"]')];
    expect(input.getAttribute('aria-controls')).toBe(listbox.id);
    expect(options.length).toBeGreaterThan(1);
    expect(input.getAttribute('aria-activedescendant')).toBe(options[0]!.id);
    expect(options[0]!.getAttribute('aria-selected')).toBe('true');

    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
    expect(input.getAttribute('aria-activedescendant')).toBe(options[1]!.id);
    expect(options[1]!.getAttribute('aria-selected')).toBe('true');

    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(view.container.querySelector('output')?.textContent).toBe('/brands');
    view.unmount();
  });

  it('keeps available commands usable when a remote catalog fails and offers retry', async () => {
    vi.mocked(api.listProjects).mockRejectedValue(new Error('offline'));
    const view = renderComponent(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <CommandPalette />
      </MemoryRouter>,
    );
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true })));
    await flushPromises();
    await flushPromises();

    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('Some projects or libraries could not be searched');
    expect(view.container.querySelectorAll('[role="option"]').length).toBeGreaterThan(0);
    view.unmount();
  });
});
