# UX consistency, accessibility, and recovery

## Outcome

Finish issue #85 without changing VPA's information architecture or visual identity. Existing production-console surfaces keep their light/dark token system, editorial headings, compact controls, and project workflow. The change establishes one predictable contract for layout height, overlay stacking, keyboard focus, asynchronous loading/failure, reduced motion, and unsaved work.

## Design system decisions

- Color: retain the existing semantic theme tokens; error/retry/loading components use `--danger`, `--accent`, `--surface`, `--border`, and their theme-aware backgrounds.
- Type: retain Inter/Newsreader/JetBrains Mono roles. Status copy stays plain sentence case and avoids decorative labels.
- Layout: async states are compact horizontal status rails that preserve the surrounding page geometry. They do not introduce another card grid.
- Motion: interactive feedback remains, but the global reduced-motion contract disables transitions and looping animation.
- Overlays: named z-index tokens define navigation, popovers, jobs, command palette, app modals, confirmations, and toasts. Focus is trapped and restored consistently.

## Behavior

1. A single `--nav-height` token drives the navbar and every full-height workspace calculation.
2. Brand-generation progress receives namespaced CSS so it cannot inherit the project-overview pipeline layout.
3. The command palette uses combobox/listbox/option semantics, `aria-activedescendant`, focus trapping, focus restoration, and bounded recovery when one catalog query fails.
4. Shared loading and load-error components provide useful retry actions without replacing already loaded data.
5. Dashboard projects/brands, Brands, Voices, and Setup expose retry. Setup reports the age of the displayed probe data and distinguishes a failed refresh from a fresh result.
6. Unsaved dialog exits use the in-app confirmation service. Browser unload protection remains native because browsers require it.

## Compatibility and boundaries

No API changes are required. Existing routes, project data, query keys, and theme tokens remain compatible. This slice does not redesign individual feature editors, replace all inline styles, or add cosmetic animation.
