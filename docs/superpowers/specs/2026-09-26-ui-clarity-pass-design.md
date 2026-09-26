# UI clarity pass

## Outcome

Make VPA understandable at a glance without removing its advanced production controls. Each major surface should answer one question first:

- Dashboard: how do I start or reopen work?
- Project: what should I do next?
- Navigation: where am I in the production flow?
- Render: can I export now?

## Design principles

1. Put the primary workflow in plain language and keep it visible.
2. Show one dominant next action before previews and configuration.
3. Use progressive disclosure for occasional or advanced controls.
4. Keep the existing editor-like visual language, color system, and capabilities.
5. Prefer task labels over system labels and avoid decorative micro-headings.

## Changes

### Dashboard

- Rename the three entry points to “Start with an idea”, “Import slides”, and “Import recordings”.
- Simplify the recent-project toolbar into one compact row.
- Replace always-visible rename/archive/remove controls with a single per-project actions menu.

### Project navigation

- Show the complete production path as first-class links: Overview, Scenes, Script, Narration, Render, Review.
- Keep Recordings and On-screen text under “More tools”.
- Remove duplicate Brand and Voice library links from the project sidebar; those remain in global navigation.

### Project overview

- Place project progress and its next action before the media preview.
- Use a two-column summary at wide widths so the current output remains visible without pushing the next action below the fold.

### Render

- Put final-render readiness and the render button first.
- Collapse render customization, output variants, scene order, and background music by default.
- Keep all existing options one click away and preserve their defaults.

## Accessibility and responsive behavior

- All actions remain keyboard reachable and retain explicit accessible names.
- Native `details` elements provide disclosure behavior without custom focus management.
- The overview and dashboard collapse to one column on narrow screens.
- Compact project navigation retains labels, icons, and tooltips.

## Acceptance criteria

- A user can identify the six-step project workflow without opening a menu.
- The project next action and render action are visible in the initial viewport on a typical desktop.
- Secondary project actions do not compete visually with Open.
- Advanced render controls remain available but do not precede the primary action.
- Existing project, rendering, and configuration behavior is unchanged.
