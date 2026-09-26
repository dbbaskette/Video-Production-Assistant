# UI clarity pass implementation plan

## Scope

Implement the approved clarity pass in the existing React web application. This is an information-hierarchy change, not a feature removal or a visual-system rewrite.

## Slice 1: Entry and navigation

Files: `apps/web/src/pages/Dashboard.tsx`, `apps/web/src/components/ProjectList.tsx`, `apps/web/src/components/ProjectSidebar.tsx`, `apps/web/src/styles.css`, related tests.

- Use direct task language for project creation.
- Compact search/sort/open-folder controls.
- Move project management actions into a native overflow disclosure.
- Promote Script, Narration, Render, and Review into the core project navigation.
- Verify dashboard routing, project actions, navigation persistence, and keyboard-reachable controls.

## Slice 2: Next-action-first overview

Files: `apps/web/src/pages/ProjectOverview.tsx`, `apps/web/src/components/ProjectMediaSummary.tsx`, `apps/web/src/styles.css`.

- Group the progress card and media preview in a responsive overview summary.
- Put the progress card first in source and visual order.
- Tighten media sizing and update export wording.
- Verify loading/error states still render independently.

## Slice 3: Export-first render page

Files: `apps/web/src/pages/RenderPage.tsx`, `apps/web/src/pages/ProjectOverview.tsx`, `apps/web/src/styles.css`.

- Render the final-output card before secondary sections.
- Put render customization behind a native disclosure.
- Collapse output formats, scene order, and background music into clearly labeled sections.
- Verify selections and defaults continue to flow into the render request.

## Integrated verification

- Run focused component tests for changed surfaces.
- Run the complete web test suite and production build once the slices are complete.
- Inspect Dashboard, Project Overview, and Render in the running application at desktop and narrow widths.

## Exclusions

- No API, persistence, or render-pipeline changes.
- No removal of brands, voices, variants, music, frame styles, or other production controls.
- No re-theme of the application.
