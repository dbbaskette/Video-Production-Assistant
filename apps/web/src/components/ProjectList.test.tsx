import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectTrackerEntry } from '@vpa/shared';
import { api } from '../lib/api.js';
import { renderComponent } from './component-test-utils.js';
import { ProjectList } from './ProjectList.js';
import { UiProvider } from './ui/UiProvider.js';

const projects: ProjectTrackerEntry[] = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Zulu',
    path: '/Work/zulu',
    lastOpened: '2026-08-01T12:00:00.000Z',
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'Alpha',
    path: '/Work/alpha',
    lastOpened: '2026-08-03T12:00:00.000Z',
  },
  {
    id: '33333333-3333-4333-8333-333333333333',
    name: 'Missing',
    path: '/Work/missing',
    lastOpened: '2026-08-04T12:00:00.000Z',
    missing: true,
  },
];

describe('ProjectList', () => {
  beforeEach(() => {
    vi.spyOn(api, 'listProjects').mockResolvedValue({ projects });
    vi.spyOn(api, 'removeProjectFromTracker').mockResolvedValue({ removed: true });
    vi.spyOn(api, 'pruneMissingProjects').mockResolvedValue({ removed: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('searches, sorts, reports counts, and resets an empty result', async () => {
    const view = renderProjectList();
    await waitForUi(() => expect(view.container.textContent).toContain('3 of 3 projects'));

    changeValue(inputByLabel(view.container, 'Search recent projects'), 'no match');
    expect(view.container.textContent).toContain('No projects match this search');
    expect(view.container.textContent).toContain('0 of 3 projects');

    act(() => buttonByText(view.container, 'Reset filters').click());
    expect(view.container.textContent).toContain('3 of 3 projects');

    changeValue(selectByLabel(view.container, 'Sort recent projects'), 'name-desc');
    const cards = [...view.container.querySelectorAll('.project-list-card__name')]
      .map((element) => element.textContent);
    expect(cards).toEqual(['Zulu', 'Alpha', 'Missing']);
    view.unmount();
  });

  it('opens from a keyboard-reachable link and keeps remove outside it', async () => {
    const onOpen = vi.fn();
    const view = renderProjectList(onOpen);
    await waitForUi(() => expect(view.container.querySelector('[aria-label="Open Alpha"]')).not.toBeNull());

    const open = view.container.querySelector<HTMLAnchorElement>('[aria-label="Open Alpha"]')!;
    const remove = view.container.querySelector<HTMLButtonElement>(
      '[aria-label="Remove Alpha from recent projects"]',
    )!;
    expect(open.getAttribute('href')).toBe(`/project/${projects[1]!.id}`);
    expect(open.contains(remove)).toBe(false);

    act(() => open.click());
    expect(onOpen).toHaveBeenCalledWith(projects[1]);

    act(() => remove.click());
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      'Remove "Alpha" from the list?',
    );
    view.unmount();
  });

  it('keeps missing projects non-openable and exposes folder import', async () => {
    const onOpenFolder = vi.fn();
    const view = renderProjectList(vi.fn(), onOpenFolder);
    await waitForUi(() => expect(view.container.textContent).toContain('Missing'));

    expect(view.container.querySelector('[aria-label="Open Missing"]')).toBeNull();
    act(() => buttonByText(view.container, 'Open existing project…').click());
    expect(onOpenFolder).toHaveBeenCalledOnce();
    view.unmount();
  });

  it('directs a true zero state to create or open a project', async () => {
    vi.mocked(api.listProjects).mockResolvedValueOnce({ projects: [] });
    const view = renderProjectList();
    await waitForUi(() => expect(view.container.textContent).toContain('No projects yet'));
    expect(view.container.textContent).toContain('0 projects');
    expect(view.container.textContent).not.toContain('No projects match this search');
    view.unmount();
  });
});

function renderProjectList(onOpen = vi.fn(), onOpenFolder = vi.fn()) {
  return renderComponent(
    <UiProvider>
      <ProjectList onOpen={onOpen} onOpenFolder={onOpenFolder} />
    </UiProvider>,
  );
}

function inputByLabel(container: ParentNode, label: string): HTMLInputElement {
  return container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
}

function selectByLabel(container: ParentNode, label: string): HTMLSelectElement {
  return container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
}

function buttonByText(container: ParentNode, label: string): HTMLButtonElement {
  return [...container.querySelectorAll('button')]
    .find((button) => button.textContent?.trim() === label)!;
}

function changeValue(element: HTMLInputElement | HTMLSelectElement, value: string): void {
  const prototype = element instanceof HTMLSelectElement
    ? HTMLSelectElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  act(() => {
    setter?.call(element, value);
    element.dispatchEvent(new Event('change', { bubbles: true }));
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

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
