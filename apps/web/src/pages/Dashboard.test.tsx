import { act } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { brandsApi } from '../lib/api.js';
import { renderComponent } from '../components/component-test-utils.js';
import { Dashboard } from './Dashboard.js';

vi.mock('../components/ProjectList.js', () => ({ ProjectList: () => <div /> }));
vi.mock('../components/BrandCard.js', () => ({ BrandCard: () => <div /> }));
vi.mock('../components/OpenFolderDialog.js', () => ({ OpenFolderDialog: () => null }));
vi.mock('../components/NewProjectDialog.js', () => ({
  NewProjectDialog: ({ open, mode, onCreated }: {
    open: boolean;
    mode: string;
    onCreated(id: string, result?: { presentationId: string }): void;
  }) => open ? (
    <button onClick={() => onCreated(
      '11111111-1111-4111-8111-111111111111',
      mode === 'presentation' ? { presentationId: 'deck/one' } : undefined,
    )}>Complete {mode}</button>
  ) : null,
}));

function Location() {
  return <output aria-label="Location">{useLocation().pathname}{useLocation().search}</output>;
}

describe('Dashboard presentation entry', () => {
  beforeEach(() => {
    vi.spyOn(brandsApi, 'list').mockResolvedValue({ brands: [], default_brand_id: null });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('offers the presentation hero and preserves parent-owned encoded navigation', () => {
    const view = renderComponent(
      <MemoryRouter
        initialEntries={['/']}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <Routes>
          <Route path="*" element={<><Dashboard /><Location /></>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(view.container.textContent).toContain('I have a presentation');
    expect(view.container.textContent).toContain("Upload a PDF; we'll create one narratable scene per slide.");
    const hero = view.container.querySelector<HTMLButtonElement>('button[aria-label="I have a presentation"]')!;
    act(() => hero.click());
    const complete = [...view.container.querySelectorAll('button')]
      .find((candidate) => candidate.textContent === 'Complete presentation')!;
    act(() => complete.click());
    expect(view.container.querySelector('output')?.textContent).toBe(
      '/project/11111111-1111-4111-8111-111111111111/storyboard?presentation=deck%2Fone',
    );
    view.unmount();
  });
});
