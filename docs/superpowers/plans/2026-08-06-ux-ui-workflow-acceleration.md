# UX/UI Workflow Acceleration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the approved five UX and five UI improvements that make projects and large storyboards faster to find, navigate, and focus.

**Architecture:** Keep the change frontend-only inside `apps/web`. Put deterministic search, sort, filter, navigation, shortcut, and preference behavior in small pure helpers; keep transient control state in the owning React views; preserve the existing React Query data and `scene` URL parameter as authoritative state.

**Tech Stack:** React 18, TypeScript, React Router, TanStack Query, Lucide React, CSS, Vitest, jsdom.

## Global Constraints

- Do not change API routes, shared schemas, server behavior, project YAML, or destructive-confirmation semantics.
- Do not add dependencies.
- Preserve unknown URL query parameters when scene selection changes.
- Keep missing project entries removable but not openable and always sorted after valid entries.
- Keep the selected scene visible when filters exclude it.
- Persist only `projectNavCollapsed`; focus mode remains session-only.
- Keep every project phase reachable in the compact rail with an accessible name and tooltip.
- Run targeted tests at milestone boundaries and the full relevant suite once before completion.

---

## File Structure

- Create `apps/web/src/lib/project-list-view.ts` for normalized project search and stable sorting.
- Create `apps/web/src/lib/project-list-view.test.ts` for project helper behavior.
- Modify `apps/web/src/components/ProjectList.tsx` to own dashboard query/sort state and render the toolbar/cards.
- Create `apps/web/src/components/ProjectList.test.tsx` for dashboard project-list interactions and semantics.
- Create `apps/web/src/lib/workspace-preferences.ts` for versioned, failure-safe local preference parsing and persistence.
- Create `apps/web/src/lib/workspace-preferences.test.ts` for preference behavior.
- Modify `apps/web/src/pages/ProjectWorkspace.tsx` to own collapsed navigation and focus mode and expose both through outlet context.
- Modify `apps/web/src/components/ProjectSidebar.tsx` to render expanded or compact navigation without losing destinations.
- Create `apps/web/src/pages/ProjectWorkspace.test.tsx` for collapse, persistence, and focus restoration.
- Create `apps/web/src/lib/storyboard-navigation.ts` for scene filters, status derivation, visible order, neighboring selection, shortcut eligibility, and removal selection.
- Create `apps/web/src/lib/storyboard-navigation.test.ts` for the pure scene behavior.
- Modify `apps/web/src/pages/StoryboardView.tsx` to render the filter toolbar, pinned selection, keyboard navigation, redesigned cards, sticky context bar, and focus mode.
- Modify `apps/web/src/pages/StoryboardView.test.tsx` for integrated filtering, navigation, query preservation, actions, and focus behavior.
- Modify `apps/web/src/styles.css` for the dashboard toolbar/cards, compact rail, storyboard toolbar/cards/context bar, focus mode, themes, and responsive layouts.

---

### Task 1: Project list view model

**Files:**
- Create: `apps/web/src/lib/project-list-view.ts`
- Create: `apps/web/src/lib/project-list-view.test.ts`

**Interfaces:**
- Consumes: `ProjectTrackerEntry` from `@vpa/shared`.
- Produces: `ProjectSort = 'recent' | 'name-asc' | 'name-desc'`, `normalizeProjectQuery(value: string): string`, and `filterAndSortProjects(projects: readonly ProjectTrackerEntry[], query: string, sort: ProjectSort): ProjectTrackerEntry[]`.

- [ ] **Step 1: Write failing helper tests**

```ts
import { describe, expect, it } from 'vitest';
import { filterAndSortProjects, normalizeProjectQuery } from './project-list-view.js';

const projects = [
  { id: 'a', name: 'Zulu', path: '/Work/alpha-demo', lastOpened: '2026-08-01T12:00:00.000Z' },
  { id: 'b', name: 'Alpha', path: '/Work/zulu-demo', lastOpened: '2026-08-03T12:00:00.000Z' },
  { id: 'c', name: 'Missing', path: '/Work/missing', lastOpened: '2026-08-04T12:00:00.000Z', missing: true },
] as const;

it('trims and folds project queries across names and paths', () => {
  expect(normalizeProjectQuery('  ALPHA  ')).toBe('alpha');
  expect(filterAndSortProjects(projects, 'ALPHA', 'recent').map((p) => p.id)).toEqual(['b', 'a']);
});

it('keeps missing entries last in every stable sort', () => {
  expect(filterAndSortProjects(projects, '', 'recent').map((p) => p.id)).toEqual(['b', 'a', 'c']);
  expect(filterAndSortProjects(projects, '', 'name-asc').map((p) => p.id)).toEqual(['b', 'a', 'c']);
  expect(filterAndSortProjects(projects, '', 'name-desc').map((p) => p.id)).toEqual(['a', 'b', 'c']);
});

it('preserves tracker order when recent dates tie', () => {
  const tied = projects.slice(0, 2).map((p) => ({ ...p, lastOpened: null }));
  expect(filterAndSortProjects(tied, '', 'recent').map((p) => p.id)).toEqual(['a', 'b']);
});
```

- [ ] **Step 2: Run the helper test and confirm it fails**

Run: `npm test -w @vpa/web -- project-list-view.test.ts`

Expected: FAIL because `project-list-view.ts` does not exist.

- [ ] **Step 3: Implement normalized search and stable sorting**

```ts
import type { ProjectTrackerEntry } from '@vpa/shared';

export type ProjectSort = 'recent' | 'name-asc' | 'name-desc';

export function normalizeProjectQuery(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export function filterAndSortProjects(
  projects: readonly ProjectTrackerEntry[],
  query: string,
  sort: ProjectSort,
): ProjectTrackerEntry[] {
  const normalized = normalizeProjectQuery(query);
  return projects
    .map((project, index) => ({ project, index }))
    .filter(({ project }) => !normalized
      || project.name.toLocaleLowerCase().includes(normalized)
      || project.path.toLocaleLowerCase().includes(normalized))
    .sort((a, b) => {
      if (!!a.project.missing !== !!b.project.missing) return a.project.missing ? 1 : -1;
      if (sort === 'recent') {
        const delta = (Date.parse(b.project.lastOpened ?? '') || 0)
          - (Date.parse(a.project.lastOpened ?? '') || 0);
        return delta || a.index - b.index;
      }
      const delta = a.project.name.localeCompare(b.project.name, undefined, { sensitivity: 'base' });
      return (sort === 'name-asc' ? delta : -delta) || a.index - b.index;
    })
    .map(({ project }) => project);
}
```

- [ ] **Step 4: Run the helper test and confirm it passes**

Run: `npm test -w @vpa/web -- project-list-view.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the project view model**

```bash
git add apps/web/src/lib/project-list-view.ts apps/web/src/lib/project-list-view.test.ts
git commit -m "feat: add project discovery view model"
```

---

### Task 2: Dashboard toolbar and accessible project cards

**Files:**
- Modify: `apps/web/src/components/ProjectList.tsx`
- Create: `apps/web/src/components/ProjectList.test.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Consumes: `filterAndSortProjects()` and `ProjectSort` from Task 1, `ProjectTrackerEntry`, existing `api.listProjects`, tracker removal APIs, and `onOpen(project)`.
- Produces: a labelled project search field, sort selector, clear/reset controls, result count, true zero state, filtered empty state, link-like project open controls, and separate remove buttons.

- [ ] **Step 1: Write failing component tests for toolbar, reset, and card semantics**

```tsx
it('searches, sorts, reports counts, and resets an empty result', async () => {
  vi.spyOn(api, 'listProjects').mockResolvedValue({ projects });
  const view = renderProjectList();
  await waitForUi(() => expect(view.container.textContent).toContain('3 of 3 projects'));
  changeValue(view.container.querySelector('[aria-label="Search recent projects"]')!, 'no match');
  expect(view.container.textContent).toContain('No projects match this search');
  act(() => buttonByText(view.container, 'Reset filters').click());
  expect(view.container.textContent).toContain('3 of 3 projects');
});

it('opens from a keyboard-reachable link and keeps remove outside it', async () => {
  const onOpen = vi.fn();
  const view = renderProjectList(onOpen);
  await waitForUi(() => expect(view.container.querySelector('[aria-label="Open Alpha"]')).not.toBeNull());
  const open = view.container.querySelector<HTMLAnchorElement>('[aria-label="Open Alpha"]')!;
  const remove = view.container.querySelector<HTMLButtonElement>('[aria-label="Remove Alpha from recent projects"]')!;
  expect(open.contains(remove)).toBe(false);
  act(() => open.click());
  expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ name: 'Alpha' }));
});
```

- [ ] **Step 2: Run the component test and confirm it fails**

Run: `npm test -w @vpa/web -- ProjectList.test.tsx`

Expected: FAIL because the toolbar and link card markup are absent.

- [ ] **Step 3: Move the Open folder action into the project-list toolbar contract**

Extend `ProjectList` with `onOpenFolder(): void`, pass `() => setModal('open')` from `Dashboard`, and remove the duplicate section-header button. Keep the Recent section label above the component.

```tsx
<ProjectList
  onOpen={(project) => handleOpen(project.id)}
  onOpenFolder={() => setModal('open')}
/>
```

- [ ] **Step 4: Add local query/sort state and derived results**

```tsx
const [projectQuery, setProjectQuery] = useState('');
const [projectSort, setProjectSort] = useState<ProjectSort>('recent');
const visibleProjects = useMemo(
  () => filterAndSortProjects(projects, projectQuery, projectSort),
  [projects, projectQuery, projectSort],
);
const resetFilters = () => {
  setProjectQuery('');
  setProjectSort('recent');
};
```

Render a `role="search"` toolbar containing the labelled input, clear button, labelled select with all three options, live text `${visibleProjects.length} of ${projects.length} projects`, and Open folder button. Render “No projects match this search” with Reset filters only when the source list is non-empty and the derived list is empty.

- [ ] **Step 5: Replace click-only rows with split card semantics**

For a valid project, render a real `<a href={`/project/${p.id}`}>` whose `onClick` prevents default and calls `onOpen(p)` so router behavior remains parent-owned in tests. Give it `aria-label={`Open ${p.name}`}`. Keep the remove `<button>` as a sibling with `aria-label={`Remove ${p.name} from recent projects`}`. For a missing project, render the same card metadata without the link.

- [ ] **Step 6: Add dashboard toolbar and card CSS**

Add focused classes under the dashboard section:

```css
.project-list-toolbar { display: grid; grid-template-columns: minmax(220px, 1fr) auto auto auto; gap: 10px; align-items: end; }
.project-list-search { position: relative; min-width: 0; }
.project-list-card { display: flex; align-items: stretch; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--bg-elev); }
.project-list-card__open { flex: 1; min-width: 0; padding: 14px 16px; color: inherit; text-decoration: none; }
.project-list-card__open:hover, .project-list-card__open:focus-visible { background: var(--accent-bg); outline: 2px solid var(--accent); outline-offset: -2px; }
@media (max-width: 720px) { .project-list-toolbar { grid-template-columns: 1fr 1fr; } }
```

Use existing theme variables only so light and dark themes remain aligned.

- [ ] **Step 7: Run the dashboard and project-list tests**

Run: `npm test -w @vpa/web -- ProjectList.test.tsx Dashboard.test.tsx`

Expected: PASS.

- [ ] **Step 8: Commit the dashboard slice**

```bash
git add apps/web/src/components/ProjectList.tsx apps/web/src/components/ProjectList.test.tsx apps/web/src/pages/Dashboard.tsx apps/web/src/styles.css
git commit -m "feat: accelerate recent project discovery"
```

---

### Task 3: Workspace preference and compact project navigation

**Files:**
- Create: `apps/web/src/lib/workspace-preferences.ts`
- Create: `apps/web/src/lib/workspace-preferences.test.ts`
- Modify: `apps/web/src/pages/ProjectWorkspace.tsx`
- Modify: `apps/web/src/components/ProjectSidebar.tsx`
- Create: `apps/web/src/pages/ProjectWorkspace.test.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Consumes: browser `Storage`, current `ProjectSidebar` pipeline steps, project/brand queries, and nested project routes.
- Produces: `WORKSPACE_PREFERENCE_KEY`, `WorkspacePreferences`, `DEFAULT_WORKSPACE_PREFERENCES`, `readWorkspacePreferences(storage?: Storage): WorkspacePreferences`, `writeWorkspacePreferences(value: WorkspacePreferences, storage?: Storage): boolean`, and exported `WorkspaceOutletContext` with `project`, `projectNavCollapsed`, `setProjectNavCollapsed`, `focusMode`, and `setFocusMode`.

- [ ] **Step 1: Write failing preference tests**

```ts
it('accepts only the current boolean preference shape', () => {
  storage.setItem(WORKSPACE_PREFERENCE_KEY, JSON.stringify({ projectNavCollapsed: true }));
  expect(readWorkspacePreferences(storage)).toEqual({ projectNavCollapsed: true });
  storage.setItem(WORKSPACE_PREFERENCE_KEY, JSON.stringify({ version: 0, projectNavCollapsed: true }));
  expect(readWorkspacePreferences(storage)).toEqual(DEFAULT_WORKSPACE_PREFERENCES);
});

it('falls back when storage reads or writes fail', () => {
  const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } } as unknown as Storage;
  expect(readWorkspacePreferences(broken)).toEqual(DEFAULT_WORKSPACE_PREFERENCES);
  expect(writeWorkspacePreferences({ projectNavCollapsed: true }, broken)).toBe(false);
});
```

- [ ] **Step 2: Run preference tests and confirm they fail**

Run: `npm test -w @vpa/web -- workspace-preferences.test.ts`

Expected: FAIL because the helper is absent.

- [ ] **Step 3: Implement versioned, safe preference I/O**

```ts
export const WORKSPACE_PREFERENCE_KEY = 'vpa.workspace.layout.v1';
export interface WorkspacePreferences { projectNavCollapsed: boolean }
export const DEFAULT_WORKSPACE_PREFERENCES: WorkspacePreferences = { projectNavCollapsed: false };

function browserStorage(): Storage | undefined {
  try { return globalThis.localStorage; }
  catch { return undefined; }
}

export function readWorkspacePreferences(storage?: Storage): WorkspacePreferences {
  try {
    const parsed = JSON.parse((storage ?? browserStorage())?.getItem(WORKSPACE_PREFERENCE_KEY) ?? 'null') as unknown;
    if (parsed && typeof parsed === 'object'
      && Object.keys(parsed).length === 1
      && typeof (parsed as WorkspacePreferences).projectNavCollapsed === 'boolean') {
      return { projectNavCollapsed: (parsed as WorkspacePreferences).projectNavCollapsed };
    }
  } catch { /* storage is optional UI state */ }
  return DEFAULT_WORKSPACE_PREFERENCES;
}

export function writeWorkspacePreferences(value: WorkspacePreferences, storage?: Storage): boolean {
  const target = storage ?? browserStorage();
  try { target?.setItem(WORKSPACE_PREFERENCE_KEY, JSON.stringify(value)); return !!target; }
  catch { return false; }
}
```

- [ ] **Step 4: Add failing workspace component tests**

Cover these assertions in `ProjectWorkspace.test.tsx` with mocked project, brand, and pipeline queries:

```tsx
expect(view.container.querySelector('[aria-label="Collapse project navigation"]')).not.toBeNull();
act(() => buttonByLabel(view.container, 'Collapse project navigation').click());
expect(view.container.querySelector('[aria-label="Expand project navigation"]')).not.toBeNull();
for (const label of ['Overview', 'Storyboard', 'Recordings', 'Script', 'Narration', 'Lower Thirds', 'Render', 'Review', 'Brands', 'All projects']) {
  expect(view.container.querySelector(`[aria-label="${label}"]`)).not.toBeNull();
}
expect(JSON.parse(localStorage.getItem(WORKSPACE_PREFERENCE_KEY)!)).toEqual({ projectNavCollapsed: true });
```

- [ ] **Step 5: Run the workspace test and confirm it fails**

Run: `npm test -w @vpa/web -- ProjectWorkspace.test.tsx`

Expected: FAIL because collapsed navigation and outlet layout controls are absent.

- [ ] **Step 6: Own layout state in `ProjectWorkspace`**

Initialize the preference once with a lazy state initializer, persist only explicit collapse/expand changes, keep `focusMode` in `useState(false)`, omit the project sidebar when focused, and pass the full `WorkspaceOutletContext` to `<Outlet context={...} />`.

```tsx
const [projectNavCollapsed, setProjectNavCollapsedState] = useState(
  () => readWorkspacePreferences().projectNavCollapsed,
);
const [focusMode, setFocusMode] = useState(false);
const setProjectNavCollapsed = (collapsed: boolean) => {
  setProjectNavCollapsedState(collapsed);
  writeWorkspacePreferences({ projectNavCollapsed: collapsed });
};
```

- [ ] **Step 7: Render expanded and compact sidebar variants**

Add `collapsed` and `onCollapsedChange` props. The expanded header gets `aria-label="Collapse project navigation"`. The compact rail gets `aria-label="Expand project navigation"` and icon-only `NavLink`s with matching `title` and `aria-label`. Use Lucide icons for Overview and every workflow step; keep Brands and All projects in a visually separated overflow/library group at the bottom.

- [ ] **Step 8: Add compact rail and responsive CSS**

Use `.project-sidebar--compact` at `64px`, center its icons, retain active colors/status dots, and keep the existing horizontal phone treatment. At phone widths, do not force the 64px desktop width; preserve the horizontal route strip and expose the expand/collapse control.

- [ ] **Step 9: Run preference and workspace tests**

Run: `npm test -w @vpa/web -- workspace-preferences.test.ts ProjectWorkspace.test.tsx`

Expected: PASS.

- [ ] **Step 10: Commit the workspace slice**

```bash
git add apps/web/src/lib/workspace-preferences.ts apps/web/src/lib/workspace-preferences.test.ts apps/web/src/pages/ProjectWorkspace.tsx apps/web/src/pages/ProjectWorkspace.test.tsx apps/web/src/components/ProjectSidebar.tsx apps/web/src/styles.css
git commit -m "feat: add compact project navigation"
```

---

### Task 4: Storyboard navigation view model

**Files:**
- Create: `apps/web/src/lib/storyboard-navigation.ts`
- Create: `apps/web/src/lib/storyboard-navigation.test.ts`

**Interfaces:**
- Consumes: `Scene` and `SceneType` from `@vpa/shared`, plus a DOM `EventTarget` for shortcut eligibility.
- Produces: `SceneReadiness = 'all' | 'needs-recording' | 'needs-script' | 'needs-narration'`, `SceneFilters`, `DEFAULT_SCENE_FILTERS`, `sceneHasScript(scene)`, `sceneHasNarrationAudio(scene)`, `filterStoryboardScenes(scenes, filters)`, `displayedSceneOrder(scenes, selectedId, filters)`, `sceneNeighbor(displayed, selectedId, direction)`, `canUseSceneShortcut(event)`, and `sceneSelectionAfterRemoval(previous, next, selectedId)`.

- [ ] **Step 1: Write failing filter, ordering, boundary, shortcut, and removal tests**

```ts
it('composes text, type, and readiness filters', () => {
  expect(filterStoryboardScenes(scenes, {
    query: 'checkout', type: 'browser', readiness: 'needs-narration',
  }).map((scene) => scene.id)).toEqual(['browser-scripted']);
});

it('pins a filtered-out selection exactly once', () => {
  const order = displayedSceneOrder(scenes, 'terminal-ready', {
    query: '', type: 'browser', readiness: 'all',
  });
  expect(order.map((scene) => scene.id)).toEqual(['terminal-ready', 'browser-scripted']);
});

it('does not wrap neighboring selection', () => {
  expect(sceneNeighbor(scenes, scenes[0]!.id, -1)).toBeNull();
  expect(sceneNeighbor(scenes, scenes.at(-1)!.id, 1)).toBeNull();
});

it.each(['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'])('rejects %s shortcut targets', (tag) => {
  expect(canUseSceneShortcut(keyboardEvent('[', document.createElement(tag)))).toBe(false);
});

it('chooses the same index, prior index, then none after removal', () => {
  expect(sceneSelectionAfterRemoval(scenes, [scenes[0]!, scenes[2]!], scenes[1]!.id)).toBe(scenes[2]!.id);
  expect(sceneSelectionAfterRemoval(scenes, scenes.slice(0, 1), scenes[2]!.id)).toBe(scenes[0]!.id);
  expect(sceneSelectionAfterRemoval(scenes, [], scenes[0]!.id)).toBeNull();
});
```

- [ ] **Step 2: Run the navigation helper tests and confirm they fail**

Run: `npm test -w @vpa/web -- storyboard-navigation.test.ts`

Expected: FAIL because the helper is absent.

- [ ] **Step 3: Implement script/audio/readiness derivation exactly as specified**

```ts
export function sceneHasScript(scene: Scene): boolean {
  const narration = scene.narration;
  return [narration?.script, narration?.monologueScript, narration?.dialogScript]
    .some((value) => !!value?.trim());
}

export function sceneHasNarrationAudio(scene: Scene): boolean {
  return !!scene.narration?.audio || !!scene.narration?.chunks?.some((chunk) => !!chunk.audio);
}
```

The readiness predicate must use: recording absent; every script blank; or script present and both top-level/chunk audio absent. Text match uses trimmed, case-folded `name` plus `description`. Type `all` bypasses type matching.

- [ ] **Step 4: Implement pinned ordering and neighbors without duplication or wrapping**

Filter source order, find the selected scene from the unfiltered source, and prepend it only when it is absent from matches. `sceneNeighbor` returns the adjacent ID or `null` at boundaries/missing selections.

- [ ] **Step 5: Implement shortcut eligibility and removal selection**

Reject Meta, Control, or Alt; anything except `[`/`]`; targets inside `input`, `textarea`, `select`, `button`, `a`, `[contenteditable="true"]`, `[role="menu"]`, `[role="dialog"]`; and events while any open dialog exists. Return same-index successor, then prior scene, then no scene after removal.

- [ ] **Step 6: Run navigation helper tests and confirm they pass**

Run: `npm test -w @vpa/web -- storyboard-navigation.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit the navigation view model**

```bash
git add apps/web/src/lib/storyboard-navigation.ts apps/web/src/lib/storyboard-navigation.test.ts
git commit -m "feat: add storyboard navigation view model"
```

---

### Task 5: Storyboard filter toolbar, scene cards, context bar, and focus mode

**Files:**
- Modify: `apps/web/src/pages/StoryboardView.tsx`
- Modify: `apps/web/src/pages/StoryboardView.test.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Consumes: Task 4 helpers and the `WorkspaceOutletContext` produced by Task 3.
- Produces: composable scene search/type/readiness controls, pinned current scene, URL-preserving previous/next navigation with bracket shortcuts, redesigned stable scene card regions, sticky scene context bar, and session-only editor focus mode.

- [ ] **Step 1: Add failing integration tests for filters and pinned selection**

Extend the storyboard fixture with browser, terminal, desktop, and slide scenes in varied readiness states. Assert that text/type/readiness controls compose, counts update, Reset restores the list, and a selected non-match appears under “Current scene — outside filters” exactly once.

```tsx
changeValue(view.container.querySelector('[aria-label="Search scenes"]')!, 'checkout');
changeValue(view.container.querySelector('[aria-label="Scene type"]')!, 'browser');
changeValue(view.container.querySelector('[aria-label="Scene readiness"]')!, 'needs-narration');
expect(view.container.textContent).toContain('1 of 4 scenes');
expect(view.container.textContent).toContain('Current scene — outside filters');
```

- [ ] **Step 2: Add failing integration tests for navigation and shortcuts**

Assert Previous/Next disable at displayed boundaries; navigation changes only `scene` while preserving `tab`, `presentation`, and unknown parameters; `[`/`]` invoke the same navigation; and brackets typed into search/scene editor fields do not navigate.

- [ ] **Step 3: Add failing integration tests for scene cards, context, and focus**

Assert each card has stable number/type/title/status regions, selected state, explicit action names, and action container state classes. Assert the context bar shows “Scene N of M”, full title, type, and focus action. Click Focus editor and verify both `.project-sidebar` and `.storyboard-rail` disappear; press Escape and verify both return with the prior compact/expanded preference intact.

- [ ] **Step 4: Run the extended storyboard tests and confirm they fail**

Run: `npm test -w @vpa/web -- StoryboardView.test.tsx`

Expected: FAIL because filtering, neighboring navigation, sticky context, and focus controls are absent.

- [ ] **Step 5: Add local scene filters and displayed order**

```tsx
const [sceneFilters, setSceneFilters] = useState(DEFAULT_SCENE_FILTERS);
const displayedScenes = useMemo(
  () => displayedSceneOrder(scenes, selectedSceneId, sceneFilters),
  [scenes, selectedSceneId, sceneFilters],
);
const matchingScenes = useMemo(
  () => filterStoryboardScenes(scenes, sceneFilters),
  [scenes, sceneFilters],
);
```

Render the toolbar in the scene rail with labelled search/type/readiness inputs, `${matchingScenes.length} of ${scenes.length} scenes`, and Reset. If selected is outside matches, render a labelled pinned group before the match list and omit the selected scene from the normal group.

- [ ] **Step 6: Centralize URL-preserving selection and navigation**

```tsx
const selectScene = useCallback((sceneId: string) => {
  setSearchParams((current) => {
    const next = new URLSearchParams(current);
    next.set('scene', sceneId);
    return next;
  });
}, [setSearchParams]);
```

Use `sceneNeighbor(displayedScenes, selectedSceneId, direction)` for buttons and a window `keydown` effect. Call `canUseSceneShortcut(event)` before handling brackets. Prevent default only when navigation occurs.

- [ ] **Step 7: Move removal selection to the helper**

Update `normalizeStoryboardAfterRemoval` to call `sceneSelectionAfterRemoval(previousScenes, nextScenes, selectedId)` so same-index/prior/none behavior has one definition. Keep filters untouched and preserve all non-scene search parameters.

- [ ] **Step 8: Redesign scene-card markup**

Replace ad hoc inline status icons with three labelled chips: Recording (`Ready`/`Missing`), Script (`Ready`/`Missing`), Narration (`narrated/total` when chunks exist, otherwise `Ready`/`Missing`). Preserve full accessible action names and DOM presence. Add `scene-row--selected` and `.scene-row__actions`; CSS reveals actions for `.scene-row--selected`, `:hover`, and `:focus-within` while keeping them keyboard reachable.

- [ ] **Step 9: Add the sticky scene context bar**

At the top of `.storyboard-detail`, render selected scene index in the full saved order, type chip, full title with `title`, Previous, Next, and Focus editor/Exit focus buttons. Keep it outside the keyed `ScenePage` so it remains stable during scene changes.

- [ ] **Step 10: Wire focus mode through workspace context**

Read `focusMode` and `setFocusMode` from outlet context. When focused, `ProjectWorkspace` omits the project sidebar and `StoryboardView` omits the scene rail. Add an Escape effect that exits focus only when `document.querySelector('dialog[open], [role="dialog"]')` is absent. Do not persist focus state.

- [ ] **Step 11: Add storyboard presentation and responsive CSS**

Add classes for a compact filter grid, pinned group, three-region cards, status chips, action reveal, sticky context bar, focused one-column layout, title clamping, and two-row wrapping below 900px. Ensure scene controls remain visible without horizontal overflow at 640px and preserve the existing stacked storyboard behavior.

- [ ] **Step 12: Run storyboard, workspace, and dashboard regression tests**

Run: `npm test -w @vpa/web -- StoryboardView.test.tsx ProjectWorkspace.test.tsx ProjectList.test.tsx Dashboard.test.tsx`

Expected: PASS.

- [ ] **Step 13: Commit the storyboard slice**

```bash
git add apps/web/src/pages/StoryboardView.tsx apps/web/src/pages/StoryboardView.test.tsx apps/web/src/styles.css
git commit -m "feat: accelerate storyboard navigation"
```

---

### Task 6: Full verification, live UI evidence, PR, and merge

**Files:**
- Modify only files needed for issues proven by verification.

**Interfaces:**
- Consumes: all five implementation tasks.
- Produces: passing repository checks, light/dark desktop/narrow visual evidence for every approved item, a reviewed PR, merged `main`, and a clean post-merge verification.

- [ ] **Step 1: Run the full relevant automated checks**

Run:

```bash
npm test
npm run typecheck
npm run lint
npm run build
git diff --check
```

Expected: all commands exit 0 with no warnings promoted to failures.

- [ ] **Step 2: Start the app through the repository startup path**

Run: `./start.sh`

Expected: the server and web app start with repository `.env` values and the dashboard is reachable at its reported local URL.

- [ ] **Step 3: Inspect the populated dashboard in light and dark themes**

Using the in-app browser, verify project name/path search, all three sorts, count, clear/reset, keyboard focus, split open/remove card semantics, missing-entry cleanup, empty results, and responsive layout at desktop and narrow widths. Capture screenshots for the PR description or verification notes.

- [ ] **Step 4: Inspect a 20+ scene storyboard in light and dark themes**

Verify combined filters, pinned selected scene, Previous/Next buttons, `[`/`]`, input shortcut suppression, compact/expanded project navigation persistence across reload, all phase destinations, action reveal on hover/focus/selection, sticky context while scrolling, focus enter/exit, same scene preservation, and desktop/narrow layouts without inaccessible overflow.

- [ ] **Step 5: Fix only evidence-backed issues and rerun affected checks**

For each observed problem, record the failing interaction, patch the smallest responsible component/helper/style, rerun its targeted test, then repeat the relevant live interaction. Do not broaden scope beyond the approved ten improvements.

- [ ] **Step 6: Run completion audit against all ten improvements**

Create a checklist mapping each approved UX/UI item to its source file, automated test, and successful live interaction. Treat any item missing one of those three forms of evidence as incomplete and continue work.

- [ ] **Step 7: Commit final verification fixes**

```bash
git add apps/web docs/superpowers
git commit -m "test: verify UX UI workflow acceleration"
```

Skip this commit only when verification produces no file changes.

- [ ] **Step 8: Push and open the pull request**

```bash
git push -u origin codex/ux-ui-workflow-acceleration
gh pr create --base main --head codex/ux-ui-workflow-acceleration --title "Improve project and storyboard navigation" --body-file /tmp/vpa-ux-ui-pr.md
```

The PR body must enumerate the five UX and five UI improvements and include the exact verification commands and visual scenarios.

- [ ] **Step 9: Review the PR and resolve findings**

Run the repository's required PR review workflow, inspect GitHub checks, address every valid finding with targeted tests, push follow-up commits, and wait for all required checks to pass.

- [ ] **Step 10: Merge and verify `main`**

```bash
gh pr merge --squash --delete-branch
git switch main
git pull --ff-only
git status --short --branch
git log -1 --oneline
```

Expected: PR is merged, local `main` matches the merge commit, and the worktree is clean.
