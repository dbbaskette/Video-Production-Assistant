# UX/UI Workflow Acceleration Design

## Summary

Improve the highest-frequency path through VPA: find a project, open a large
storyboard, locate the right scene, and keep the editor focused on that scene.
This is a frontend-only batch aimed at a frequent solo user. It adds five UX
improvements and five UI improvements without changing project files, API
schemas, or server behavior.

## Goals

- Make recent projects quick to find and open without scanning paths manually.
- Keep storyboards with 20 or more scenes navigable by mouse and keyboard.
- Preserve scene context while filters or layout preferences change.
- Give the editor more usable width without removing access to project phases.
- Replace click-only and icon-only affordances with accessible, self-explanatory
  controls.

## Non-goals

- No project-status or workflow-status recomputation; the canonical status model
  remains unchanged.
- No drag-and-drop scene reordering, thumbnail generation, virtualized lists, or
  resizable panes.
- No server routes, shared schemas, or persisted project-file fields.
- No redesign of scene-editor content below its new context bar.
- No change to destructive confirmation semantics.

## Approved improvements

### UX improvements

1. **Search recent projects.** Match project name and path case-insensitively.
2. **Sort recent projects.** Offer Recent, Name A–Z, and Name Z–A.
3. **Search and filter storyboard scenes.** Combine free-text search with scene
   type and incomplete-status filters.
4. **Navigate scenes quickly.** Add Previous and Next controls plus `[` and `]`
   shortcuts over the currently visible scene set.
5. **Focus the workspace.** Remember a compact project-navigation preference
   locally and provide a session-only focus mode that hides both rails.

### UI improvements

1. **Accessible project cards.** Replace click-only list rows with keyboard-
   reachable cards that have a clear open affordance and separate remove action.
2. **Project-list toolbar.** Present search, sort, result count, and reset as one
   compact control group with a purposeful empty-result state.
3. **Compact project navigation.** Give the project sidebar a labelled collapse
   control and an icon-based compact rail that preserves every phase link.
4. **Clearer scene cards.** Strengthen scene number/type/title hierarchy,
   standardize status indicators, and reveal edit/reorder/remove actions only
   for the selected, hovered, or keyboard-focused card.
5. **Sticky scene context bar.** Keep scene position, title, type, Previous,
   Next, and focus controls visible above the editor while the detail pane
   scrolls.

## Architecture

The change stays inside `apps/web`. Existing React Query data remains the source
of projects and storyboard scenes. New pure view-model helpers isolate search,
sorting, filtering, navigation, and preference parsing from React components:

- `lib/project-list-view.ts` owns project-query normalization, matching, and
  stable sorting.
- `lib/storyboard-navigation.ts` owns scene-filter normalization, matching,
  visible-scene ordering, previous/next resolution, shortcut eligibility, and
  selected-scene normalization after removal.
- `lib/workspace-preferences.ts` owns a versioned local preference, safe parsing,
  and a storage-unavailable fallback.

`ProjectList` owns its local search and sort controls because they are dashboard
presentation state. `ProjectSidebar` reads the workspace preference supplied by
`ProjectWorkspace` and renders either its current full layout or a compact rail.
`StoryboardView` owns scene filters, filtered-scene navigation, and the sticky
context bar because the URL-selected scene and scene list already live there.

No helper reads or writes project YAML. The only URL mutation is the existing
`scene` query parameter.

## Dashboard behavior

The Recent section starts with all valid projects sorted by last-opened time,
with missing projects still sunk to the bottom. The toolbar contains:

- a labelled search input with a clear button;
- a labelled sort select with Recent, Name A–Z, and Name Z–A;
- a live result count such as “4 of 12 projects”;
- the existing Open folder action.

Project cards use a real link for the open target. The project name is the card's
accessible name, the path remains secondary text, and the last-opened value is
visible metadata. The remove button is outside the link target and retains the
existing confirmation. Missing entries remain non-openable and keep the cleanup
flow.

If no project matches, the section says “No projects match this search” and
offers Reset filters. A true zero-project state continues to say that no
projects exist and points at the creation choices above.

## Storyboard filtering and navigation

The scene toolbar contains:

- text search over scene name and description;
- scene type: All, Desktop, Browser, Terminal, Slide;
- readiness: All, Needs recording, Needs script, Needs narration;
- a result count and Reset filters action.

Readiness uses only existing scene fields:

- “Needs recording” means `scene.recording` is absent.
- “Needs script” means every available narration script field—`script`,
  `monologueScript`, and `dialogScript`—is absent or blank.
- “Needs narration” means at least one of those script fields is non-blank but
  `audio` is absent and no narration chunk has an `audio` path.

The filter does not turn narration into a required workflow step.

Filtering never changes saved scene order or scene content. If the selected
scene does not match the active filters, it remains visible in a separate
“Current scene — outside filters” slot above the matching results. The detail
editor therefore never disappears because a filter changed.

Previous and Next operate over the displayed order: the pinned current scene,
when present, followed by matching scenes without duplication. Navigation does
not wrap at either end. `[` and `]` invoke the same actions. Shortcuts are
ignored when the event target is an input, textarea, select, contenteditable
element, button, link, menu, or open dialog, and when Meta, Control, or Alt is
pressed.

When the selected scene is removed, selection moves to the scene at the same
index when one exists, otherwise the preceding scene, otherwise no scene. Active
filters remain intact.

## Workspace focus and compact navigation

`ProjectWorkspace` owns one versioned preference:

```text
vpa.workspace.layout.v1 = { projectNavCollapsed: boolean }
```

The default is expanded. Storage parse or write errors silently fall back to the
default and never block navigation. The full sidebar exposes a labelled
“Collapse project navigation” button. Compact mode keeps the project overview
and seven workflow destinations as icon buttons with tooltips and accessible
names, plus an “Expand project navigation” button. Brand and library-only links
move to the compact rail's overflow group rather than disappearing.

On the storyboard route, a “Focus editor” control in the context bar temporarily
hides both the project rail and scene rail. Exiting focus mode restores their
previous expanded/compact state. Focus mode is session UI state and is not
persisted; the project-navigation collapsed preference is persisted. Escape
exits focus mode unless a dialog is open.

## Scene-card and context-bar presentation

Every scene card contains three stable regions:

1. a number/type block;
2. the truncated scene title;
3. compact labelled status chips for Recording, Script, and Narration count.

The full action group—Move up, Move down, Rename, Remove—is visually hidden until
the card is selected, hovered, or contains keyboard focus. It remains in the DOM
and becomes visible on `:focus-within`, so keyboard access does not depend on
hover. Buttons keep explicit accessible names and disabled boundary states.

The sticky context bar sits at the top of the detail column and shows “Scene 4
of 23”, the type chip, full title, Previous/Next buttons, and Focus editor. It
uses the existing selected-scene URL state, so there is no parallel selection
model. At narrow widths it wraps into two rows rather than horizontally
overflowing.

## Data flow

1. Dashboard fetches the current project tracker response.
2. Local project query and sort state pass through the pure project-list helper.
3. Storyboard fetches the current storyboard as it does today.
4. Local scene filters pass through the pure scene-navigation helper.
5. Selecting, navigating, or removing a scene updates the existing URL query.
6. The workspace preference is parsed once at layout mount and updated only by
   explicit collapse/expand actions.
7. Mutations retain their existing React Query invalidation behavior.

## Error and edge-case behavior

- A project-query failure keeps the existing error state and does not show an
  empty-result message.
- Missing project entries remain sortable, searchable, and removable but not
  openable.
- Empty scene results retain the current scene when possible and provide Reset.
- Invalid stored preferences are discarded in memory, not rewritten
  automatically.
- Keyboard shortcuts never intercept typing or standard modified shortcuts.
- The compact rail exposes text through accessible names and tooltips.
- The sticky bar tolerates long titles with line clamping and a native title
  tooltip.
- Scene removal continues to use the existing confirmation and failure toast.

## Testing

### Unit tests

- Project search matches name and path, trims whitespace, and is case-insensitive.
- Project sorts are stable, missing entries remain last, and date ties preserve
  tracker order.
- Scene filters compose across text, type, and readiness.
- A selected scene outside filters is pinned exactly once.
- Previous/Next boundaries do not wrap.
- Shortcut eligibility rejects editable, interactive, dialog, and modified-key
  targets.
- Preference parsing accepts the current version and rejects malformed or stale
  data.

### Component tests

- Project cards are keyboard-reachable links and their remove buttons do not
  trigger navigation.
- Project toolbar reports counts and resets an empty search.
- Project sidebar collapses without losing phase destinations.
- Scene-card actions appear for selection and keyboard focus.
- Sticky context controls update the scene query while preserving other query
  parameters.
- Focus mode hides and restores both rails.

### Browser tests

- Search and sort a populated dashboard.
- Filter a storyboard containing at least 20 scenes.
- Navigate filtered scenes with buttons and `[` / `]`.
- Verify typing brackets in a text field does not navigate.
- Reload after collapsing project navigation and verify the compact state.
- Enter/exit focus mode and verify the editor remains on the same scene.
- Exercise desktop and narrow layouts with no inaccessible overflow.

### Completion gates

- All shared, server, and web tests pass.
- Type-check and production build pass.
- The live dashboard and a 20+ scene storyboard are visually inspected in light
  and dark themes.
- Every approved improvement has direct source, automated-test, and live-UI
  evidence before the PR is merged.

## Rollout sequence

1. Pure project and scene view-model helpers with unit tests.
2. Dashboard toolbar and accessible project cards.
3. Workspace preference and compact project navigation.
4. Scene toolbar, filters, and quick navigation.
5. Scene-card presentation and sticky context bar.
6. Focus mode, responsive behavior, browser coverage, and final visual pass.
