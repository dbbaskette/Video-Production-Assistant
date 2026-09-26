import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderComponent } from '../component-test-utils.js';
import { LoadError, LoadingState } from './AsyncState.js';

describe('AsyncState', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  it('announces loading without replacing the page structure', () => {
    const view = renderComponent(<LoadingState label="Loading voices" detail="Checking providers." />);
    expect(view.container.querySelector('[role="status"]')?.getAttribute('aria-label')).toBe('Loading voices');
    expect(view.container.textContent).toContain('Checking providers.');
    view.unmount();
  });

  it('announces an error and exposes an explicit retry action', () => {
    const retry = vi.fn();
    const view = renderComponent(<LoadError title="Could not load" detail="Nothing changed." onRetry={retry} />);
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('Could not load');
    act(() => view.container.querySelector('button')!.click());
    expect(retry).toHaveBeenCalledOnce();
    view.unmount();
  });
});
